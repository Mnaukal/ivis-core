"""
Code for running the trained models for prediction.
"""
import numpy as np
import pandas as pd
import tensorflow as tf
from ivis import ivis
from .common import get_aggregated_field
from . import elasticsearch as es
from .preprocessing import get_column_names, preprocess_using_coefficients


def load_data(prediction_parameters):
    """
    Generates the queries, runs them in Elasticsearch and parses the data.

    Parameters
    ----------
    prediction_parameters : ivis.nn.PredictionParams

    Returns
    -------
    pd.DataFrame
    """
    index = prediction_parameters.index
    # TODO: handle data for multiple predictions at the same time
    input_width = prediction_parameters.input_width
    if prediction_parameters.interval is not None:
        aggregation_interval = f"{prediction_parameters.interval}ms"
        query = es.get_histogram_query(prediction_parameters.input_signals, prediction_parameters.ts_field, aggregation_interval, size=input_width)  # TODO: time interval
        results = ivis.elasticsearch.search(index, query)
        return es.parse_histogram(prediction_parameters.input_signals, results)
    else:
        query = es.get_docs_query(prediction_parameters.input_signals, prediction_parameters.ts_field, size=input_width)  # TODO: time interval
        results = ivis.elasticsearch.search(index, query)
        return es.parse_docs(prediction_parameters.input_signals, results)


def get_windowed_dataset(prediction_parameters, dataframe):
    return tf.keras.preprocessing.timeseries_dataset_from_array(
        data=np.array(dataframe, dtype=np.float32),
        targets=None,
        sequence_length=prediction_parameters.input_width,
        sequence_stride=1,
        shuffle=False)


##################
# Postprocessing #
##################


def get_column_indices(normalization_coefficients, signals):
    column_names = get_column_names(normalization_coefficients, signals)
    return {c: i for i, c in enumerate(column_names)}


def _postprocess_sample(sample, signals, normalization_coefficients, column_indices):
    """
    Apply postprocessing the to one predicted sample to denormalize the data, etc.

    Parameters
    ----------
    normalization_coefficients : dict
    column_indices : dict
    sample : np.ndarray
        Shape is [time, signals]

    Returns
    -------
    pd.DataFrame
        The columns correspond to the `PredictionParams.target_signals`. TODO: and rows corresponding to the timestamp of the prediction
    """

    dataframe = pd.DataFrame()

    def mean_std_denormalization(column, mean, std):
        data = sample[:, column_indices[column]]
        dataframe[column] = data * std + mean

    def min_max_denormalization(column, min_val, max_val):
        data = sample[:, column_indices[column]]
        dataframe[column] = data[column] * (max_val - min_val) + min_val

    def one_hot_decoding(column, values):
        values += ["unknown"]
        value_indices = [column_indices[f"{column}_{val}"] for val in values]

        data = []
        for row in sample:
            encoded = row[value_indices]
            most_probable = np.argmax(encoded)
            data.append(values[most_probable])
        dataframe[column] = data

    def postprocess_signal(column):
        coeffs = normalization_coefficients[column]

        if "min" in coeffs and "max" in coeffs:
            return min_max_denormalization(column, coeffs["min"], coeffs["max"])
        elif "mean" in coeffs and "std" in coeffs:
            return mean_std_denormalization(column, coeffs["mean"], coeffs["std"])
        elif "values" in coeffs:
            return one_hot_decoding(column, coeffs["values"])
        raise ValueError(f"Unknown target signal '{column}'.")

    for sig in signals:
        col = get_aggregated_field(sig)
        postprocess_signal(col)

    return dataframe


def postprocess(prediction_parameters, data):
    """
    Apply postprocessing the to a batch of predictions to denormalize the data, etc.

    Parameters
    ----------
    prediction_parameters : ivis.nn.PredictionParams
    data : np.ndarray
        The shape of the array is [samples, time, signals]

    Returns
    -------
    list[pd.DataFrame]
        Each dataframe in the list has the columns corresponding to the `PredictionParams.target_signals`. TODO: and rows corresponding to the timestamp of the prediction
    """
    signals = prediction_parameters.target_signals
    normalization_coefficients = prediction_parameters.normalization_coefficients
    column_indices = get_column_indices(prediction_parameters.normalization_coefficients, prediction_parameters.target_signals)
    return [_postprocess_sample(sample, signals, normalization_coefficients, column_indices) for sample in data]


##################
# Run prediction #
##################


def run_prediction(prediction_parameters, model_path, log_callback=print):
    """
    Predicts future values using the given model and new data.

    Parameters
    ----------
    prediction_parameters : ivis.nn.PredictionParams
        The parameters from user parsed from the JSON parameters of the IVIS Job. It should also contain the signal set,
        signals and their types.
    model_path : str
        Path to load the model from and save the model if it was updated.
    log_callback : callable
        Function to print to Job log.

    Returns
    -------
    bool
        Whether the model was updated and should be uploaded to IVIS server. TODO: this is probably unnecessary as we can simply save the model back to the file from which it was loaded
    any
        New predictions to be inserted into the signal set in Elasticsearch.
    """

    log_callback("Initializing...")

    try:
        log_callback("Loading data...")
        dataframe = load_data(prediction_parameters)
        log_callback("Processing data...")
        dataframe = preprocess_using_coefficients(prediction_parameters.normalization_coefficients, dataframe)
        print(dataframe)  # TODO (MT): remove

        dataset = get_windowed_dataset(prediction_parameters, dataframe)
        log_callback("Data successfully loaded.")
        for d in dataset.as_numpy_iterator():  # TODO (MT): remove
            print(d)

    except es.NoDataError:
        log_callback("No data in the defined time range, can't continue.")
        raise es.NoDataError from None

    log_callback("Loading model...")
    model = tf.keras.models.load_model(model_path)
    model.summary(print_fn=log_callback)

    log_callback("Computing predictions...")
    predicted = model.predict(dataset)

    predicted_dataframes = postprocess(prediction_parameters, predicted)

    log_callback("Saving data...")  # TODO (MT)
    return True, predicted_dataframes