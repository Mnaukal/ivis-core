'use strict';

import React, {Component} from "react";
import * as d3Scale from "d3-scale";
import * as d3Format from "d3-format";
import * as d3Selection from "d3-selection";
import {select} from "d3-selection";
import * as d3Array from "d3-array";
import * as d3Color from "d3-color";
import * as d3Zoom from "d3-zoom";
import {intervalAccessMixin} from "./TimeContext";
import {DataAccessSession} from "./DataAccess";
import {withAsyncErrorHandler, withErrorHandling} from "../lib/error-handling";
import PropTypes from "prop-types";
import {withComponentMixins} from "../lib/decorator-helpers";
import {withTranslation} from "../lib/i18n";
import {Tooltip} from "./Tooltip";
import {Icon} from "../lib/bootstrap-components";
import {
    AreZoomTransformsEqual, createChartCursorArea,
    getColorScale, RenderStatus,
} from "./common";
import {PropType_d3Color} from "../lib/CustomPropTypes";
import {ZoomableChartBase} from "./ZoomableChartBase";

const ConfigDifference = {
    NONE: 0,
    RENDER: 1,
    DATA: 2,
    DATA_WITH_CLEAR: 3
};

function compareConfigs(conf1, conf2) {
    let diffResult = ConfigDifference.NONE;

    if (conf1.sigSetCid !== conf2.sigSetCid || conf1.x_sigCid !== conf2.x_sigCid || conf1.y_sigCid !== conf2.y_sigCid || conf1.tsSigCid !== conf2.tsSigCid) {
        diffResult = ConfigDifference.DATA_WITH_CLEAR;
    } else if (conf1.colors !== conf2.colors) {
        diffResult = ConfigDifference.RENDER;
    }

    return diffResult;
}

class TooltipContent extends Component {
    constructor(props) {
        super(props);
    }

    static propTypes = {
        config: PropTypes.object.isRequired,
        signalSetsData: PropTypes.object,
        selection: PropTypes.object,
        tooltipFormat: PropTypes.func.isRequired
    };

    render() {
        if (this.props.selection) {
            const xStep = this.props.signalSetsData.step;
            const yStep = this.props.signalSetsData.buckets[0].step;
            const bucket = this.props.selection;

            let xDescription;
            if (xStep !== undefined) { // NUMBER
                const xKeyF = d3Format.format("." + d3Format.precisionFixed(xStep) + "f");
                xDescription = <div>X axis range: <Icon icon="chevron-left"/>{xKeyF(bucket.xKey)} <Icon icon="ellipsis-h"/> {xKeyF(bucket.xKey + xStep)}<Icon icon="chevron-right"/></div>
            }
            else // KEYWORD
                xDescription = <div>X axis: {bucket.xKey}</div>;

            let yDescription;
            if (yStep !== undefined) { // NUMBER
                const yKeyF = d3Format.format("." + d3Format.precisionFixed(yStep) + "f");
                yDescription = <div>Y axis range: <Icon icon="chevron-left"/>{yKeyF(bucket.key)} <Icon icon="ellipsis-h"/> {yKeyF(bucket.key + yStep)}<Icon icon="chevron-right"/></div>
            }
            else // KEYWORD
                yDescription = <div>Y axis: {bucket.key}</div>;

            const probF = d3Format.format(".2f");

            return (
                <div>
                    {xDescription}
                    {yDescription}
                    <div>{this.props.tooltipFormat(bucket)}</div>
                    <div>Frequency: {probF(bucket.prob * 100)}%</div>
                </div>
            );

        } else {
            return null;
        }
    }
}

const DataType = {
    NUMBER: 0,
    KEYWORD: 1
};

/** 2D histogram */
@withComponentMixins([
    withTranslation,
    withErrorHandling,
    intervalAccessMixin()
], ["getView", "setView"], ["processBucket", "prepareData", "getKeywordExtent", "getKeys"])
export class HeatmapChart extends Component {
    constructor(props){
        super(props);

        const t = props.t;

        this.dataAccessSession = new DataAccessSession();
        this.state = {
            signalSetData: null,
            statusMsg: t('Loading...'),
            width: undefined,
            height: 0,
            maxBucketCountX: 0,
            maxBucketCountY: 0,
        };

        this.xExtent = [0, 0];
        this.yExtent = [0, 0];
    }

    static propTypes = {
        config: PropTypes.shape({
            sigSetCid: PropTypes.string.isRequired,
            x_sigCid: PropTypes.string.isRequired,
            y_sigCid: PropTypes.string.isRequired,
            colors: PropTypes.arrayOf(PropType_d3Color()),
            tsSigCid: PropTypes.string,
            metric_sigCid: PropTypes.string,
            metric_type: PropTypes.oneOf(["sum", "min", "max", "avg"])
        }).isRequired,
        height: PropTypes.number.isRequired,
        margin: PropTypes.object,
        overviewBottomHeight: PropTypes.number,
        overviewBottomMargin: PropTypes.object,
        overviewBottomColor: PropType_d3Color(),
        overviewLeftWidth: PropTypes.number,
        overviewLeftMargin: PropTypes.object,
        overviewLeftColor: PropType_d3Color(),

        withTooltip: PropTypes.bool,
        withOverviewBottom: PropTypes.bool,
        withOverviewLeft: PropTypes.bool,
        withOverviewLeftBrush: PropTypes.bool,
        withOverviewBottomBrush: PropTypes.bool,
        withTransition: PropTypes.bool,
        withZoomX: PropTypes.bool,
        withZoomY: PropTypes.bool,
        tooltipFormat: PropTypes.func, // bucket => line in tooltip

        xAxisTicksCount: PropTypes.number,
        xAxisTicksFormat: PropTypes.func,
        xAxisLabel: PropTypes.string,
        yAxisTicksCount: PropTypes.number,
        yAxisTicksFormat: PropTypes.func,
        yAxisLabel: PropTypes.string,

        minStepX: PropTypes.number,
        minStepY: PropTypes.number,
        minRectWidth: PropTypes.number,
        minRectHeight: PropTypes.number,
        maxBucketCountX: PropTypes.number,
        maxBucketCountY: PropTypes.number,
        xMinValue: PropTypes.number,
        xMaxValue: PropTypes.number,
        yMinValue: PropTypes.number,
        yMaxValue: PropTypes.number,

        viewChangeCallback: PropTypes.func,

        zoomLevelMin: PropTypes.number,
        zoomLevelMax: PropTypes.number,

        className: PropTypes.string,
        style: PropTypes.object,

        filter: PropTypes.object,
        processBucket: PropTypes.func, // see HeatmapChart.processBucket for reference
        prepareData: PropTypes.func, // see HeatmapChart.prepareData for reference
    };

    static defaultProps = {
        margin: { left: 40, right: 5, top: 5, bottom: 20 },
        minRectWidth: 40,
        minRectHeight: 40,
        withTooltip: true,
        withOverviewBottom: true,
        withOverviewLeft: true,
        withOverviewLeftBrush: true,
        withOverviewBottomBrush: true,
        withTransition: true,
        withZoomX: true,
        withZoomY: true,
        tooltipFormat: bucket => `Count: ${bucket.count}`,

        xMinValue: NaN,
        xMaxValue: NaN,
        yMinValue: NaN,
        yMaxValue: NaN,

        zoomLevelMin: 1,
        zoomLevelMax: 4,

        overviewBottomHeight: 60,
        overviewBottomMargin: { top: 0, bottom: 20 },
        overviewLeftWidth: 70,
        overviewLeftMargin: { left: 30, right: 0 }
    };
    static defaultColors = ["#ffffff", "#1c70ff"]; // default value for props.config.colors

    /** Update and redraw the chart based on changes in React props and state */
    componentDidUpdate(prevProps, prevState) {
        const t = this.props.t;

        let configDiff = compareConfigs(this.props.config, prevProps.config);

        // test if time interval changed
        const considerTs = !!this.props.config.tsSigCid;
        if (considerTs) {
            const prevAbs = this.getIntervalAbsolute(prevProps);
            const prevSpec = this.getIntervalSpec(prevProps);

            if (prevSpec !== this.getIntervalSpec()) {
                configDiff = Math.max(configDiff, ConfigDifference.DATA_WITH_CLEAR);
            } else if (prevAbs !== this.getIntervalAbsolute()) { // If its just a regular refresh, don't clear the chart
                configDiff = Math.max(configDiff, ConfigDifference.DATA);
            }
        }

        // test if limits changed
        if (!Object.is(prevProps.xMinValue, this.props.xMinValue) || !Object.is(prevProps.xMaxValue, this.props.xMaxValue) || !Object.is(prevProps.yMinValue, this.props.yMinValue) || !Object.is(prevProps.yMaxValue, this.props.yMaxValue))
            configDiff = Math.max(configDiff, ConfigDifference.DATA_WITH_CLEAR);

        if (prevState.maxBucketCountX !== this.state.maxBucketCountX ||
            prevState.maxBucketCountY !== this.state.maxBucketCountY) {
            configDiff = Math.max(configDiff, ConfigDifference.DATA);
        }

        if (configDiff === ConfigDifference.DATA_WITH_CLEAR) {
            this.base.resetZoom(/* causedByUser: */ true);
            this.setState({
                statusMsg: t('Loading...')
            }, () => {
                // noinspection JSIgnoredPromiseFromCall
                this.fetchData();
            });
        }
        else if (configDiff === ConfigDifference.DATA) {
            // noinspection JSIgnoredPromiseFromCall
            this.fetchData();
        } else {
            const forceRefresh = prevState.signalSetData !== this.state.signalSetData
                || configDiff !== ConfigDifference.NONE;

            this.base.createChart(forceRefresh, false);
        }
    }

    /** Fetches new data for the chart, processes the results using this.prepareData method and updates the state accordingly, so the chart is redrawn */
    @withAsyncErrorHandler
    async fetchData() {
        const config = this.props.config;

        let maxBucketCountX = this.props.maxBucketCountX || this.state.maxBucketCountX;
        let maxBucketCountY = this.props.maxBucketCountY || this.state.maxBucketCountY;
        if (maxBucketCountX > 0 && maxBucketCountY > 0) {
            this.setState({statusMsg: this.props.t('Loading...')});
            try {
                let filter = {
                    type: 'and',
                    children: []
                };
                if (config.tsSigCid) {
                    const abs = this.getIntervalAbsolute();
                    filter.children.push({
                        type: 'range',
                        sigCid: config.tsSigCid,
                        gte: abs.from.toISOString(),
                        lt: abs.to.toISOString()
                    });
                }
                if (!isNaN(this.props.xMinValue))
                    filter.children.push({
                        type: "range",
                        sigCid: config.x_sigCid,
                        gte: this.props.xMinValue
                    });
                if (!isNaN(this.props.xMaxValue))
                    filter.children.push({
                        type: "range",
                        sigCid: config.x_sigCid,
                        lte: this.props.xMaxValue
                    });
                if (!isNaN(this.props.yMinValue))
                    filter.children.push({
                        type: "range",
                        sigCid: config.y_sigCid,
                        gte: this.props.yMinValue
                    });
                if (!isNaN(this.props.yMaxValue))
                    filter.children.push({
                        type: "range",
                        sigCid: config.y_sigCid,
                        lte: this.props.yMaxValue
                    });
                if (this.props.filter)
                    filter.children.push(this.props.filter);

                // filter by current zoom
                const zoomTransformX = this.base.getXZoomTransform();
                const zoomTransformY = this.base.getYZoomTransform();
                if (!AreZoomTransformsEqual(zoomTransformX, d3Zoom.zoomIdentity) || !AreZoomTransformsEqual(zoomTransformY, d3Zoom.zoomIdentity)) {
                    const scaleX = zoomTransformX.k;
                    maxBucketCountX = Math.ceil(maxBucketCountX * scaleX);
                    const scaleY = zoomTransformY.k;
                    maxBucketCountY = Math.ceil(maxBucketCountY * scaleY);
                }

                let metrics;
                if (this.props.config.metric_sigCid && this.props.config.metric_type) {
                    metrics = {};
                    metrics[this.props.config.metric_sigCid] = [this.props.config.metric_type];
                }

                const results = await this.dataAccessSession.getLatestHistogram(config.sigSetCid, [config.x_sigCid, config.y_sigCid], [maxBucketCountX, maxBucketCountY], [this.props.minStepX, this.props.minStepY], filter, metrics);

                if (results) { // Results is null if the results returned are not the latest ones
                    const prepareData = this.props.prepareData || HeatmapChart.prepareData;
                    const [processedResults, xType, yType, xExtent, yExtent] = prepareData(this, results);
                    this.xType = xType;
                    this.yType = yType;
                    this.xExtent = xExtent;
                    this.yExtent = yExtent;
                    if (processedResults.xBucketsCount === 0 || processedResults.yBucketsCount === 0) {
                        this.setState({
                            signalSetData: null,
                            statusMsg: this.props.t("No data.")
                        });
                        return;
                    }

                    this.setState({...processedResults, statusMsg: ""}, () => {
                        // call callViewChangeCallback when data new data without range filter are loaded as the xExtent and yExtent might got updated (even though this.state.zoomTransform is the same)
                        this.base.callViewChangeCallback();
                    });
                }
            } catch (err) {
                this.setState({statusMsg: this.props.t("Error loading data.")});
                throw err;
            }
        }
    }

    /**
     * The value returned from this function is used to determine the height of the bar corresponding to the bucket.
     *
     * @param {HistogramChart} self - this HistogramChart object
     * @param {object} bucket - the record from server; contains 'count' field, and also 'values' field if metrics were specified
     */
    static processBucket(self, bucket) {
        const config = self.props.config;
        if (config.metric_sigCid && config.metric_type) {
            if (!bucket.hasOwnProperty("values"))
                return 0;
            bucket.metric = bucket.values[config.metric_sigCid][config.metric_type];
            delete bucket.values;
            return bucket.metric;
        }
        else
            return bucket.count;
    }

    /**
     * Processes the results of queries and returns the data and xType, yType, xExtent and yExtent
     *
     * @param {HistogramChart} self - this HistogramChart object
     * @param {object} data - the data from server; contains at least 'buckets', 'step', 'offset' and 'agg_type' fields
     *
     * @returns {[object]} - tuple of 5 values:
     *
     *   - newState - data in form which can be directly passed to this.setState() function; should contain at least 'signalSetData', 'xBucketsCount', 'yBucketsCount' and 'maxProb' (frequency of highest bar) fields
     *   - xType, yType - numeric or keyword type of data along each axis (one of DataType)
     *   - xExtent, yExtent - [min, max] of x-axis and y-axis signal
     */
    static prepareData(self, data) {
        const props = self.props;
        let xType = data.agg_type === "histogram" ? DataType.NUMBER : DataType.KEYWORD;
        const xBucketsCount = data.buckets.length;
        let xExtent = null;
        let yExtent = null;

        if (xBucketsCount === 0)
            return [{
                signalSetData: data,
                xBucketsCount: 0,
                yBucketsCount: 0
            }, null, null, null, null];

        let yType = data.buckets[0].agg_type === "histogram" ? DataType.NUMBER : DataType.KEYWORD;
        let yBucketsCount;

        // compute xExtent
        if (xType === DataType.NUMBER) {
            let xMin = data.buckets[0].key;
            let xMax = data.buckets[xBucketsCount - 1].key + data.step;
            if (!isNaN(props.xMinValue)) xMin = props.xMinValue;
            if (!isNaN(props.xMaxValue)) xMax = props.xMaxValue;
            xExtent = [xMin, xMax];
        } else { // xType === DataType.KEYWORD
            xExtent = HeatmapChart.getKeys(data.buckets);
        }

        // compute yExtent
        if (yType === DataType.NUMBER) {
            yBucketsCount = data.buckets[0].buckets.length;
            if (yBucketsCount === 0)
                return [{
                    signalSetData: data,
                    xBucketsCount: 0,
                    yBucketsCount: 0,
                }, null, null, null, null];

            let yMin = data.buckets[0].buckets[0].key;
            let yMax = data.buckets[0].buckets[yBucketsCount - 1].key + data.buckets[0].step;
            if (!isNaN(props.yMinValue)) yMin = props.yMinValue;
            if (!isNaN(props.yMaxValue)) yMax = props.yMaxValue;
            yExtent = [yMin, yMax];
        }
        else { // yType === DataType.KEYWORD
            yExtent = HeatmapChart.getKeywordExtent(data.buckets);
            yExtent.sort((a, b) => a.localeCompare(b));
            // add missing inner buckets
            for (const bucket of data.buckets) {
                const innerKeys = HeatmapChart.getKeys(bucket.buckets);
                for (const key of yExtent)
                    if (innerKeys.indexOf(key) === -1)
                        bucket.buckets.push({ key: key, count: 0 });
                // sort inner buckets so they are in same order in all outer buckets
                bucket.buckets.sort((a, b) => a.key.localeCompare(b.key));
            }
        }

        // process buckets
        let maxValue = 0;
        let totalValue = 0;
        const processBucket = props.processBucket || HeatmapChart.processBucket;
        for (const column of data.buckets)
            for (const bucket of column.buckets) {
                bucket.value = processBucket(self, bucket);
                if (bucket.value > maxValue)
                    maxValue = bucket.value;
                totalValue += bucket.value;
            }

        // calculate probabilities of buckets
        const rowProbs = data.buckets[0].buckets.map((b, i) => { return {key: b.key, prob: 0, index: i}; });
        for (const column of data.buckets) {
            for (const [i, bucket] of column.buckets.entries()) {
                bucket.prob = bucket.value / totalValue;
                bucket.xKey = column.key;
                rowProbs[i].prob += bucket.prob;
            }
            column.prob = d3Array.sum(column.buckets, d => d.prob);
        }

        if (yType === DataType.KEYWORD) {
            // sort inner buckets by rowProbs
            rowProbs.sort((a,b) => b.prob - a.prob); // smallest to biggest prob
            const permuteKeys = rowProbs.map(d => d.index);
            yExtent = d3Array.permute(yExtent, permuteKeys);
            for (const column of data.buckets)
                column.buckets = d3Array.permute(column.buckets, permuteKeys);
        }

        return [{
            signalSetData: data,
            xBucketsCount, yBucketsCount,
            maxProb: maxValue / totalValue,
            rowProbs // colProbs are in signalSetData.buckets (outer buckets)
        }, xType, yType, xExtent, yExtent];
    }

    static getKeywordExtent(buckets_of_buckets) {
        const keys = new Set();
        for (const bucket of buckets_of_buckets)
            for (const inner_bucket of bucket.buckets)
                keys.add(inner_bucket.key);
        return [...keys];
    }

    static getKeys(buckets) {
        return buckets.map(bucket => bucket.key);
    }

    /** gets current xScale based on xType */
    getXScale(range) {
        if (!this.state.signalSetData) return null;

        if (this.xType === DataType.NUMBER)
            return d3Scale.scaleLinear()
                .domain(this.xExtent)
                .range(range);
        else // this.xType === DataType.KEYWORD
            return d3Scale.scaleBand()
                .domain(this.xExtent)
                .range(range);
    }

    /** gets current yScale based on yType */
    getYScale(range) {
        if (!this.state.signalSetData) return null;

        if (this.yType === DataType.NUMBER)
            return d3Scale.scaleLinear()
                .domain(this.yExtent)
                .range(range);
        else // this.yType === DataType.KEYWORD
            return d3Scale.scaleBand()
                .domain(this.yExtent)
                .range(range);
    }

    getGraphContent(base, xScale, yScale, xSize, ySize) {
        return (<>
            <g ref={node => this.columnsSelection = select(node)}/>
            {!base.state.zoomInProgress &&
                <g ref={node => this.highlightSelection = select(node)}/>}

            {!base.state.zoomInProgress &&
            <line ref={node => this.cursorSelection = select(node)} strokeWidth="1" stroke="rgb(50,50,50)" visibility="hidden"/>}
            <text textAnchor="middle" x="50%" y="50%" fontFamily="'Open Sans','Helvetica Neue',Helvetica,Arial,sans-serif" fontSize="14px">
                {this.state.statusMsg}
            </text>

            {this.props.withTooltip && !base.state.zoomInProgress &&
            <Tooltip
                config={this.props.config}
                signalSetsData={this.state.signalSetData}
                containerHeight={ySize}
                containerWidth={xSize}
                mousePosition={this.state.mousePosition}
                selection={this.state.selection}
                contentRender={props => <TooltipContent {...props} tooltipFormat={this.props.tooltipFormat} />}
            />}

            <g ref={node => this.cursorAreaSelection = select(node)} />
        </>);
    }

    getOverviewXContent() {
        return (
            <g ref={node => this.overviewBottomBarsSelection = select(node)}/>
        );
    }

    getOverviewYContent() {
        return (
            <g ref={node => this.overviewLeftBarsSelection = select(node)}/>
        );
    }

    /** Creates (or updates) the chart with current data.
     * This method is called from componentDidUpdate automatically when state or config is updated.
     * All the 'createChart*' methods are called from here. */
    createChart(base, forceRefresh, updateZoom, xScale, yScale, xSize, ySize) {
        const signalSetData = this.state.signalSetData;

        if (this.state.xSize !== xSize || this.state.ySize !== ySize) {
            const maxBucketCountX = Math.ceil(xSize / this.props.minRectWidth);
            const maxBucketCountY = Math.ceil(ySize / this.props.minRectHeight);

            this.setState({
                xSize,
                ySize,
                maxBucketCountX,
                maxBucketCountY
            });
        }

        if (!signalSetData) {
            return RenderStatus.NO_DATA;
        }
        if (!forceRefresh && !updateZoom) {
            return RenderStatus.SUCCESS;
        }

        //<editor-fold desc="Scales">
        // x axis
        const xStep = signalSetData.step;
        const rectWidth = this.xType === DataType.NUMBER ?
            xScale(xStep) - xScale(0) :
            xScale.bandwidth();

        // y axis
        const yStep = signalSetData.buckets[0].step;
        const rectHeight = this.yType === DataType.NUMBER ?
            yScale(0) - yScale(yStep) :
            yScale.bandwidth();

        // color scale
        const colors = this.props.config.colors && this.props.config.colors.length >= 2 ? this.props.config.colors : HeatmapChart.defaultColors;
        const colorScale = getColorScale([0, this.state.maxProb], colors);
        //</editor-fold>

        this.drawRectangles(signalSetData, xScale, yScale, rectHeight, rectWidth, colorScale);

        if (this.props.withTooltip) {
            this.createChartCursor(signalSetData, xScale, yScale, rectHeight, rectWidth);
        }

        // we don't want to change the cursor area when updating only zoom (it breaks touch drag)
        if (forceRefresh)
            createChartCursorArea(this.cursorAreaSelection, xSize, ySize);

        return RenderStatus.SUCCESS;
    }

    /** Handles mouse movement to select the bin (for displaying its details in Tooltip, etc.).
     *  Called from this.createChart(). */
    createChartCursor(signalSetData, xScale, yScale, rectHeight, rectWidth) {
        const self = this;
        let selection, mousePosition;

        const selectPoints = function () {
            const containerPos = d3Selection.mouse(self.cursorAreaSelection.node());
            const [x, y] = containerPos;

            let newSelectionColumn = null;
            for (const bucket of signalSetData.buckets) {
                if (xScale(bucket.key) <= x)
                    newSelectionColumn = bucket;
                else break;
            }

            let newSelection = null;
            const yCompensate = self.yType === DataType.NUMBER ? rectHeight : 0;
            if (newSelectionColumn)
                // noinspection JSUnresolvedVariable
                for (const innerBucket of newSelectionColumn.buckets) {
                    if (yScale(innerBucket.key) + rectHeight - yCompensate >= y)
                        newSelection = innerBucket;
                    else break;
                }

            if (selection !== newSelection) {
                self.highlightSelection
                    .selectAll('rect')
                    .remove();

                if (newSelection) {
                    // noinspection JSUnresolvedVariable
                    self.highlightSelection
                        .append('rect')
                        .attr('x', xScale(newSelection.xKey))
                        .attr('y', yScale(newSelection.key) - yCompensate)
                        .attr("width", rectWidth)
                        .attr("height", rectHeight)
                        .attr("fill", "none")
                        .attr("stroke", "black")
                        .attr("stroke-width", "2px");
                }
            }

            selection = newSelection;
            mousePosition = { x, y};

            self.setState({
                selection,
                mousePosition
            });
        };

        this.cursorAreaSelection
            .on('mouseenter', selectPoints)
            .on('mousemove', selectPoints)
            .on('mouseleave', ::this.deselectPoints);
    }

    deselectPoints() {
        this.highlightSelection
            .selectAll('rect')
            .remove();

        this.setState({
            selection: null,
            mousePosition: null
        });
    };

    /** Draws rectangles for bins of data. */
    drawRectangles(signalSetData, xScale, yScale, rectHeight, rectWidth, colorScale) {
        const yCompensate = this.yType === DataType.NUMBER ? rectHeight : 0;

        const columns = this.columnsSelection
            .selectAll('g')
            .data(signalSetData.buckets);

        const rects = columns.enter()
            .append('g')
            .attr('key', d => d.key)
            .merge(columns)
            .selectAll('rect')
            .data(d => d.buckets);

        rects.enter()
            .append('rect')
            .merge(rects)
            .attr('key', d => d.key)
            .attr('x', d => xScale(d.xKey))
            .attr('y', d => yScale(d.key) - yCompensate)
            .attr("width", rectWidth)
            .attr("height", rectHeight)
            .attr("fill", d => colorScale(d.prob));

        rects.exit()
            .remove();
        columns.exit()
            .remove();
    }


    /** Returns the current view (boundaries of visible region)
     * @return {{xMin, xMax, yMin, yMax }} left, right, bottom, top boundary (numbers or strings based on the type of data on each axis)
     */
    getView() {
        if (this.base)
            return this.base.getView();
    }

    /**
     * Set the visible region of the chart to defined limits (in units of the data, not in pixels). If the axis data type is keyword (string), both boundary values are included.
     * @param xMin          left boundary of the visible region (in units of data on x-axis)
     * @param xMax          right boundary of the visible region (in units of data on x-axis)
     * @param yMin          bottom boundary of the visible region (in units of data on x-axis)
     * @param yMax          top boundary of the visible region (in units of data on x-axis)
     * @param source        the element which caused the view change (if source === this, the update is ignored)
     * @param causedByUser  tells whether the view update was caused by user (this propagates to props.viewChangeCallback call), default = false
     */
    setView(xMin, xMax, yMin, yMax, source, causedByUser = false) {
        if (source === this || this.state.signalSetData === null)
            return;
        if (this.base)
            this.base.setView(xMin, xMax, yMin, yMax, source, causedByUser);
    }

    /** Draws an additional histogram to the overview (see ZoomableChartBase.createChartOverviewY) to the left of the main chart
     *  Called from ZoomableChartBase.createChart() */
    createChartOverviewLeft(base, yScale, xSize, ySize) {
        const rowProbs = this.state.rowProbs;
        const colors = this.props.config.colors && this.props.config.colors.length >= 2 ? this.props.config.colors : HeatmapChart.defaultColors;
        const barColor = d3Color.color(this.props.overviewLeftColor || colors[colors.length - 1]);

        const maxProb = d3Array.max(rowProbs, d => d.prob);

        const xScale = d3Scale.scaleLinear() // probabilities
            .domain([0, maxProb])
            .range([0, xSize]);

        this.drawHorizontalBars(rowProbs, this.overviewLeftBarsSelection, yScale, xScale, barColor);
    }

    /** Draws an additional histogram to the overview (see ZoomableChartBase.createChartOverviewX) below the main chart
     *  Called from ZoomableChartBase.createChart() */
    createChartOverviewBottom(base, xScale, xSize, ySize) {
        const colProbs = this.state.signalSetData.buckets;
        const colors = this.props.config.colors && this.props.config.colors.length >= 2 ? this.props.config.colors : HeatmapChart.defaultColors;
        const barColor = d3Color.color(this.props.overviewLeftColor || colors[colors.length - 1]);

        const maxProb = d3Array.max(colProbs, d => d.prob);

        const yScale = d3Scale.scaleLinear() // probabilities
            .domain([0, maxProb])
            .range([ySize, 0]);

        this.drawVerticalBars(colProbs, this.overviewBottomBarsSelection, xScale, yScale, barColor);
    }

    drawVerticalBars(data, barsSelection, keyScale, probScale, barColor) {
        const bars = barsSelection
            .selectAll('rect')
            .data(data, d => d.key);
        const ySize = probScale.range()[0];
        const barWidth = (keyScale.range()[1] - keyScale.range()[0]) / data.length;

        bars.enter()
            .append('rect')
            .merge(bars)
            .attr('x', d => keyScale(d.key))
            .attr('y', d => probScale(d.prob))
            .attr("width", barWidth)
            .attr("height", d => ySize - probScale(d.prob))
            .attr("fill", barColor);

        bars.exit()
            .remove();
    }

    drawHorizontalBars(data, barsSelection, keyScale, probScale, barColor) {
        const bars = barsSelection
            .selectAll('rect')
            .data(data, d => d.key);
        const barHeight = (keyScale.range()[0] - keyScale.range()[1]) / data.length;
        const yCompensate = this.yType === DataType.NUMBER ? barHeight : 0;

        bars.enter()
            .append('rect')
            .merge(bars)
            .attr('x', 0)
            .attr('y', d => keyScale(d.key) - yCompensate)
            .attr("width", d => probScale(d.prob))
            .attr("height", barHeight)
            .attr("fill", barColor);

        bars.exit()
            .remove();
    }

    render() {
        return (
            <ZoomableChartBase
                ref={node => this.base = node}

                height={this.props.height}
                margin={this.props.margin}
                withOverviewX={this.props.withOverviewBottom}
                withOverviewXBrush={this.props.withOverviewBottomBrush}
                overviewXHeight={this.props.overviewBottomHeight}
                overviewXMargin={this.props.overviewBottomMargin}
                withOverviewY={this.props.withOverviewLeft}
                withOverviewYBrush={this.props.withOverviewLeftBrush}
                overviewYWidth={this.props.overviewLeftWidth}
                overviewYMargin={this.props.overviewLeftMargin}
                withTransition={this.props.withTransition}
                withZoomX={this.props.withZoomX}
                withZoomY={this.props.withZoomY}
                withBrush={this.props.withBrush}

                getXScale={::this.getXScale}
                getYScale={::this.getYScale}
                statusMsg={this.state.statusMsg}

                createChart={::this.createChart}
                createChartOverviewX={::this.createChartOverviewBottom}
                createChartOverviewY={::this.createChartOverviewLeft}
                getGraphContent={::this.getGraphContent}
                getOverviewXContent={::this.getOverviewXContent}
                getOverviewYContent={::this.getOverviewYContent}
                onZoomEnd={::this.deselectPoints}

                xAxisTicksCount={this.props.xAxisTicksCount}
                xAxisTicksFormat={this.props.xAxisTicksFormat}
                xAxisLabel={this.props.xAxisLabel}
                yAxisTicksCount={this.props.yAxisTicksCount}
                yAxisTicksFormat={this.props.yAxisTicksFormat}
                yAxisLabel={this.props.yAxisLabel}

                viewChangeCallback={this.props.viewChangeCallback}
                zoomLevelMin={this.props.zoomLevelMin}
                zoomLevelMax={this.props.zoomLevelMax}
                className={this.props.className}
                style={this.props.style}
            />
        );
    }
}
