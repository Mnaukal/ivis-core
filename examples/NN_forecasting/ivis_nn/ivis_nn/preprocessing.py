import numpy as np
import pandas as pd
import tensorflow as tf

from .common import *


def split_data(training_parameters, dataframe):
    """Returns three datasets for train, val, test as DataFrames"""
    split = training_parameters["split"]
    n = dataframe.shape[0]  # number of records
    train_size = int(np.floor(n * split["train"]))
    val_size = int(np.floor(n * split["val"]))
    # test_size = N - train_size - val_size
    return \
        dataframe.iloc[:train_size, :], \
        dataframe.iloc[train_size:train_size + val_size, :], \
        dataframe.iloc[train_size + val_size:, :]


def one_hot_encoding(dataframe, column, values):
    """
    Apply one-hot encoding to a column. Modifies the original dataframe!

    Parameters
    ----------
    dataframe : pd.DataFrame
    column : str
        Column name
    values : list of str
        List of unique values, ordered by the desired one-hot indices.

    Returns
    -------
    pd.DataFrame
        Modified dataframe
    """
    for val in values:
        dataframe[f"{column}_{val}"] = (dataframe[column] == val).astype(int)
    dataframe[f"{column}_unknown"] = (~dataframe[column].isin(values)).astype(int)

    dataframe.drop(columns=[column], inplace=True)
    return dataframe


def preprocess_dataframes(training_parameters, train_df, val_df, test_df):
    """
    Apply preprocessing (normalization, ...) to the train, validation and test DataFrames.

    Returns
    -------
    (pd.DataFrame, pd.DataFrame, pd.DataFrame, dict, (list, list))
        train, validation, test datasets,
        normalization coefficients for the features (should be saved)
        columns = tuple of two lists of column names for the input and target schema
    """
    input_schema = training_parameters["input_schema"]
    target_schema = training_parameters["target_schema"]
    schema = get_merged_schema(training_parameters)
    input_columns = []
    target_columns = []
    normalization_coefficients = {}
    train_df = train_df.copy()
    val_df = val_df.copy()
    test_df = test_df.copy()

    def copy_column_from_schema(original_column, new_columns=None):
        """Call this after preprocessing a column to copy it to appropriate columns lists"""
        if new_columns is None:
            new_columns = [original_column]
        for column in new_columns:
            if column in input_schema:
                input_columns.append(column)
            if column in target_schema:
                target_columns.append(column)

    def mean_std_normalization(column):
        """maps the column values to ensure mean = 0, std = 1"""
        mean = train_df[column].mean()
        std = train_df[column].std()

        train_df[column] = (train_df[column] - mean) / std
        val_df[column] = (val_df[column] - mean) / std
        test_df[column] = (test_df[column] - mean) / std

        normalization_coefficients[column] = {"mean": mean, "std": std}
        copy_column_from_schema(column)

    def min_max_normalization(column, properties):
        """maps the column's values into [0, 1] range"""
        min_val = properties["min"] if "min" in properties else train_df[column].min()
        max_val = properties["max"] if "max" in properties else train_df[column].max()

        train_df[column] = (train_df[column] - min_val) / (max_val - min_val)
        val_df[column] = (val_df[column] - min_val) / (max_val - min_val)
        test_df[column] = (test_df[column] - min_val) / (max_val - min_val)

        normalization_coefficients[column] = {"min": min_val, "max": max_val}
        copy_column_from_schema(column)

    def apply_one_hot_encoding(column):
        nonlocal train_df, val_df, test_df
        values = train_df[column].unique()

        train_df = one_hot_encoding(train_df, column, values)
        val_df = one_hot_encoding(val_df, column, values)
        test_df = one_hot_encoding(test_df, column, values)

        normalization_coefficients[column] = {"values": list(values)}
        copy_column_from_schema(column, [f"{column}_{val}" for val in values + ['unknown']])

    def preprocess_feature(column, properties):
        if "min" in properties or "max" in properties:
            min_max_normalization(column, properties)
        elif "categorical" in properties and properties["categorical"]:
            apply_one_hot_encoding(column)
        elif properties["type"] in ["integer", "long", "float", "double"]:
            mean_std_normalization(column)
        elif properties["type"] in ["keyword"]:
            apply_one_hot_encoding(column)

    for col in schema:
        preprocess_feature(col, schema[col])

    return train_df, val_df, test_df, normalization_coefficients, (input_columns, target_columns)


def preprocess_using_coefficients(normalization_coefficients, dataframe):
    """Apply preprocessing (normalization, ...) based on the `normalization_coefficients` to the dataframes. This is intended to be used during prediction."""
    dataframe = dataframe.copy()

    def mean_std_normalization(column, mean, std):
        """maps the column values to ensure mean = 0, std = 1"""
        dataframe[column] = (dataframe[column] - mean) / std

    def min_max_normalization(column, min_val, max_val):
        """maps the column's values into [0, 1] range"""
        dataframe[column] = (dataframe[column] - min_val) / (max_val - min_val)

    def apply_one_hot_encoding(column, values):
        nonlocal dataframe
        dataframe = one_hot_encoding(dataframe, column, values)

    def preprocess_feature(column):
        if column in normalization_coefficients:
            coeffs = normalization_coefficients[column]

            if "min" in coeffs and "max" in coeffs:
                min_max_normalization(column, coeffs["min"], coeffs["max"])
            elif "mean" in coeffs and "std" in coeffs:
                mean_std_normalization(column, coeffs["mean"], coeffs["std"])
            elif "values" in coeffs:
                apply_one_hot_encoding(column, coeffs["values"])

    for col in dataframe:
        preprocess_feature(col)

    return dataframe


class WindowGenerator:
    """
    Time series window dataset generator
    (inspired by https://www.tensorflow.org/tutorials/structured_data/time_series#data_windowing)

    [ #, #, #, #, #, #, #, #, #, #, #, #, # ]
     | input_width | offset | target_width |
     |               width                 |
    """
    def __init__(self, columns, dataframe, input_width, target_width, offset, batch_size=32, shuffle=False):
        self.input_width = input_width
        self.target_width = target_width
        self.offset = offset

        self.dataframe = dataframe
        self.column_indices = {name: i for i, name in enumerate(dataframe.columns)}

        # features schema
        input_column_names, target_column_names = columns
        if not target_column_names:  # target_schema is empty -> same as input_schema
            target_column_names = input_column_names

        self.input_columns = [self.column_indices[name] for name in input_column_names]
        self.target_columns = [self.column_indices[name] for name in target_column_names]

        # window parameters
        self.width = input_width + offset + target_width
        self.input_slice = slice(0, input_width)
        self.target_start = input_width + offset
        self.target_slice = slice(self.target_start, self.target_start + target_width)

        # dataset parameters
        self.batch_size = batch_size
        self.shuffle = shuffle

    def __str__(self):
        return '\n'.join([
            f'Total window width: {self.width}',
            f'Input indices: {np.arange(self.width)[self.input_slice]}',
            f'Target indices: {np.arange(self.width)[self.target_slice]}'])

    def split_window(self, batch):
        inputs = batch[:, self.input_slice, :]  # slice along the time axis
        inputs = tf.gather(inputs, self.input_columns, axis=2)  # select features
        inputs.set_shape([None, self.input_width, None])

        targets = batch[:, self.target_slice, :]  # slice along the time axis
        targets = tf.gather(targets, self.target_columns, axis=2)  # select features
        targets.set_shape([None, self.target_width, None])

        return inputs, targets

    def make_dataset(self, dataframe=None):
        """
        Creates a windowed dataset from a dataframe.

        Parameters
        ----------
        dataframe : pd.DataFrame
            The dataframe from which to make windows. If equal to `None`, the `self.dataframe` is used. The dataframe must have the same columns as `self.dataframe`.

        Returns
        -------
        tf.data.Dataset
        """
        if dataframe is None:
            dataframe = self.dataframe
        assert list(dataframe.columns) == list(self.dataframe.columns)
        if dataframe.empty:
            return None

        data = np.array(dataframe, dtype=np.float32)
        ds = tf.keras.preprocessing.timeseries_dataset_from_array(
            data=data,
            targets=None,
            sequence_length=self.width,
            sequence_stride=1,
            shuffle=self.shuffle,
            batch_size=self.batch_size, )

        ds = ds.map(self.split_window)

        return ds


def make_datasets(columns, train_df, val_df, test_df, window_params):
    """
    Convert the pd.DataFrame to windowed tf.data.Dataset.

    Parameters
    ----------
    columns : (list, list)
        tuple of two lists of column names for the input and target schema (retreived from `preprocess_dataframes`)
    train_df : pd.DataFrame
    val_df : pd.DataFrame
    test_df : pd.DataFrame
    window_params : dict
        parameters for the constructor of `WindowGenerator`

    Returns
    -------
    (tf.data.Dataset, tf.data.Dataset, tf.data.Dataset)
        train, validaion, test datasets
    """
    default_window_params = {
        "offset": 0,
    }
    default_window_params.update(window_params)
    window = WindowGenerator(columns, train_df, **default_window_params)
    train = window.make_dataset(train_df)
    val = window.make_dataset(val_df)
    test = window.make_dataset(test_df)
    return train, val, test
