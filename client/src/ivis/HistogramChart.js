'use strict';

import React, {Component} from "react";
import * as d3Scale from "d3-scale";
import * as d3Format from "d3-format";
import * as d3Selection from "d3-selection";
import {select} from "d3-selection";
import * as d3Array from "d3-array";
import * as d3Zoom from "d3-zoom";
import * as d3Color from "d3-color";
import {intervalAccessMixin} from "./TimeContext";
import {DataAccessSession} from "./DataAccess";
import {withAsyncErrorHandler, withErrorHandling} from "../lib/error-handling";
import PropTypes from "prop-types";
import {withComponentMixins} from "../lib/decorator-helpers";
import {withTranslation} from "../lib/i18n";
import {Tooltip} from "./Tooltip";
import {Icon} from "../lib/bootstrap-components";
import {
    isInExtent,
    RenderStatus,
} from "./common";
import {PropType_d3Color_Required, PropType_NumberInRange} from "../lib/CustomPropTypes";
import {XZoomableChartBase} from "./XZoomableChartBase";

const ConfigDifference = {
    NONE: 0,
    RENDER: 1,
    DATA: 2,
    DATA_WITH_CLEAR: 3
};

function compareConfigs(conf1, conf2) {
    let diffResult = ConfigDifference.NONE;

    if (conf1.sigSetCid !== conf2.sigSetCid || conf1.sigCid !== conf2.sigCid || conf1.tsSigCid !== conf2.tsSigCid) {
        diffResult = ConfigDifference.DATA_WITH_CLEAR;
    } else if (conf1.color !== conf2.color) {
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
        if (this.props.signalSetsData && this.props.selection) {
            const step = this.props.signalSetsData.step;
            const bucket = this.props.selection;

            const keyF = d3Format.format("." + d3Format.precisionFixed(step) + "f");
            const probF = d3Format.format(".2f");

            return (
                <div>
                    <div>Range: <Icon icon="chevron-left"/>{keyF(bucket.key)} <Icon icon="ellipsis-h"/> {keyF(bucket.key + step)}<Icon icon="chevron-right"/></div>
                    <div>{this.props.tooltipFormat(bucket)}</div>
                    <div>Frequency: {probF(bucket.prob * 100)}%</div>
                </div>
            );

        } else {
            return null;
        }
    }
}

@withComponentMixins([
    withTranslation,
    withErrorHandling,
    intervalAccessMixin()
], ["getView", "setView"], ["processBucket", "prepareData"])
export class HistogramChart extends Component {
    constructor(props){
        super(props);

        const t = props.t;

        this.dataAccessSession = new DataAccessSession();
        this.state = {
            signalSetData: null,
            globalSignalSetData: null,
            statusMsg: t('Loading...'),
            maxBucketCount: 0,
        };

        this.xExtent = [0, 0];
        this.yExtent = [0, 0];
    }

    static propTypes = {
        config: PropTypes.shape({
            sigSetCid: PropTypes.string.isRequired,
            sigCid: PropTypes.string.isRequired,
            color: PropType_d3Color_Required(),
            tsSigCid: PropTypes.string,
            metric_sigCid: PropTypes.string,
            metric_type: PropTypes.oneOf(["sum", "min", "max", "avg"])
        }).isRequired,
        height: PropTypes.number.isRequired,
        margin: PropTypes.object,
        overviewHeight: PropTypes.number,
        overviewMargin: PropTypes.object,

        withCursor: PropTypes.bool,
        withTooltip: PropTypes.bool,
        withOverview: PropTypes.bool,
        withTransition: PropTypes.bool,
        withZoom: PropTypes.bool,
        withBrush: PropTypes.bool,
        tooltipFormat: PropTypes.func, // bucket => line in tooltip

        xAxisTicksCount: PropTypes.number,
        xAxisTicksFormat: PropTypes.func,
        xAxisLabel: PropTypes.string,

        minStep: PropTypes.number,
        minBarWidth: PropTypes.number,
        maxBucketCount: PropTypes.number,
        topPaddingWhenZoomed: PropType_NumberInRange(0, 1), // determines whether bars will be stretched up when zooming
        xMinValue: PropTypes.number,
        xMaxValue: PropTypes.number,
        viewChangeCallback: PropTypes.func,

        zoomLevelMin: PropTypes.number,
        zoomLevelMax: PropTypes.number,

        className: PropTypes.string,
        style: PropTypes.object,

        filter: PropTypes.object,
        processBucket: PropTypes.func, // see HistogramChart.processBucket for reference
        prepareData: PropTypes.func, // see HistogramChart.prepareData for reference
    };

    static defaultProps = {
        margin: { left: 40, right: 5, top: 5, bottom: 20 },
        minBarWidth: 20,
        maxBucketCount: undefined,
        xMinValue: NaN,
        xMaxValue: NaN,
        topPaddingWhenZoomed: 0,

        withCursor: true,
        withTooltip: true,
        withOverview: true,
        withTransition: true,
        withZoom: true,
        withBrush: true,
        tooltipFormat: bucket => `Count: ${bucket.count}`,

        zoomLevelMin: 1,
        zoomLevelMax: 4,

        overviewHeight: 100,
        overviewMargin: { top: 20, bottom: 20 }
    };

    componentDidMount() {
        this.base.createChart(false, false);
    }

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
        if (!Object.is(prevProps.xMinValue, this.props.xMinValue) || !Object.is(prevProps.xMaxValue, this.props.xMaxValue))
            configDiff = Math.max(configDiff, ConfigDifference.DATA_WITH_CLEAR);

        if (prevState.maxBucketCount !== this.state.maxBucketCount)
            configDiff = Math.max(configDiff, ConfigDifference.DATA);

        if (configDiff === ConfigDifference.DATA_WITH_CLEAR) {
            this.base.resetZoom(true);
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
        }
        else {
            const forceRefresh = prevState.signalSetData !== this.state.signalSetData || configDiff !== ConfigDifference.NONE;
            this.base.createChart(forceRefresh, false);
        }
    }

    /** Fetches new data for the chart, processes the results using prepareData method and updates the state accordingly, so the chart is redrawn */
    @withAsyncErrorHandler
    async fetchData() {
        const config = this.props.config;
        const zoomTransform = this.base.getZoomTransform();

        let maxBucketCount = this.props.maxBucketCount || this.state.maxBucketCount;
        let minStep = this.props.minStep;
        if (maxBucketCount > 0) {
            try {
                let filter = {
                    type: 'and',
                        children: []
                };
                let isZoomedIn = false;
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
                        sigCid: config.sigCid,
                        gte: this.props.xMinValue
                    });
                if (!isNaN(this.props.xMaxValue))
                    filter.children.push({
                        type: "range",
                        sigCid: config.sigCid,
                        lte: this.props.xMaxValue
                    });
                if (this.props.filter)
                    filter.children.push(this.props.filter);

                // filter by current zoom
                if (!Object.is(zoomTransform, d3Zoom.zoomIdentity)) {
                    const scale = zoomTransform.k;
                    if (minStep !== undefined)
                        minStep = Math.floor(minStep / scale);
                    maxBucketCount = Math.ceil(maxBucketCount * scale);
                    isZoomedIn = true;
                }

                let metrics;
                if (this.props.config.metric_sigCid && this.props.config.metric_type) {
                    metrics = {};
                    metrics[this.props.config.metric_sigCid] = [this.props.config.metric_type];
                }

                const results = await this.dataAccessSession.getLatestHistogram(config.sigSetCid, [config.sigCid], maxBucketCount, minStep, filter, metrics);

                if (results) { // Results is null if the results returned are not the latest ones
                    const prepareData = this.props.prepareData || HistogramChart.prepareData;
                    const processedResults = prepareData(this, results);
                    if (processedResults.buckets.length === 0) {
                        this.setState({
                            signalSetData: null,
                            statusMsg: this.props.t("No data.")
                        });
                        return;
                    }
                    if (isNaN(processedResults.step)) { // not a numeric signal
                        this.setState({
                            signalSetData: null,
                            statusMsg: "Histogram not available for this type of signal."
                        });
                        return;
                    }

                    if (!isZoomedIn) { // zoomed completely out
                        // update extent of x axis
                        this.xExtent = [processedResults.min, processedResults.max];
                        if (!isNaN(this.props.xMinValue)) this.xExtent[0] = this.props.xMinValue;
                        if (!isNaN(this.props.xMaxValue)) this.xExtent[1] = this.props.xMaxValue;
                    }

                    const newState = {
                        signalSetData: processedResults,
                        statusMsg: ""
                    };
                    if (!isZoomedIn)
                        newState.globalSignalSetData = processedResults;

                    this.setState(newState, () => {
                        if (!isZoomedIn)
                            // call callViewChangeCallback when data new data without range filter are loaded as the xExtent might got updated (even though this.state.zoomTransform is the same)
                            this.base.callViewChangeCallback();
                    });
                }
            } catch (err) {
                this.setState({statusMsg: this.props.t("Error loading data."), signalSetData: null});
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
            bucket.metric = bucket.values[config.metric_sigCid][config.metric_type];
            delete bucket.values;
            return bucket.metric;
        }
        else
            return bucket.count;
    }

    /**
     * Processes the data returned from the server and returns new signalSetData object.
     *
     * @param {HistogramChart} self - this HistogramChart object
     * @param {object} data - the data from server; contains at least 'buckets', 'step' and 'offset' fields
     *
     * @returns {object} - signalSetData to be saved to state; must contain:
     *
     *   - 'buckets' - array of objects with 'key' (left boundary of the bucket) and 'prob' (frequency; height of the bucket)
     *   - 'step' - width of the bucket
     *   - 'min' and 'max' (along the x-axis)
     *   - 'maxProb' - frequency (probability) of the highest bar
     */
    static prepareData(self, data) {
        if (data.buckets.length === 0)
            return {
                buckets: data.buckets,
                step: data.step,
                offset: data.offset,
                min: NaN,
                max: NaN,
                maxProb: 0
            };

        const min = data.buckets[0].key;
        const max = data.buckets[data.buckets.length - 1].key + data.step;

        const processBucket = self.props.processBucket || HistogramChart.processBucket;
        for (const bucket of data.buckets)
            bucket.value = processBucket(self, bucket);

        let maxValue = 0;
        let totalValue = 0;
        for (const bucket of data.buckets) {
            if (bucket.value > maxValue)
                maxValue = bucket.value;
            totalValue += bucket.value;
        }

        for (const bucket of data.buckets) {
            bucket.prob = bucket.value / totalValue;
        }
        const maxProb = maxValue / totalValue;

        return {
            buckets: data.buckets,
            step: data.step,
            offset: data.offset,
            min,
            max,
            maxProb
        };
    }

    getXScale(range) {
        return d3Scale.scaleLinear()
            .domain(this.xExtent)
            .range(range);
    }

    getYScale(range) {
        return d3Scale.scaleLinear()
            .domain(this.yExtent)
            .range(range);
    }

    /** Computes the yExtent of the data filtered by the xScale updated by zoom. */
    prepareChart(base, forceRefresh, updateZoom, xScale, xSize, ySize) {
        const maxBucketCount = Math.ceil(xSize / this.props.minBarWidth);
        if (this.state.maxBucketCount !== maxBucketCount)
            this.setState({ maxBucketCount });

        /** @description last data loaded by fetchData */
        const signalSetData = this.state.signalSetData;

        if (!signalSetData || !(forceRefresh || updateZoom))
            return;

        let maxProb = signalSetData.maxProb;
        let maxProbInZoom;
        const [xDomainMin, xDomainMax] = xScale.domain();
        if (base.getZoomTransform().k > 1 && this.props.topPaddingWhenZoomed !== 1) {
            maxProbInZoom = d3Array.max(signalSetData.buckets, b => {
                if (b.key + signalSetData.step >= xDomainMin &&
                    b.key <= xDomainMax)
                    return b.prob;
            });
        }
        if (maxProbInZoom !== undefined && maxProbInZoom !== 0) {
            if (maxProbInZoom / maxProb < 1 - this.props.topPaddingWhenZoomed)
                maxProb = maxProbInZoom / (1 - this.props.topPaddingWhenZoomed);
        }
        this.yExtent = [0, maxProb];
    }

    /** Creates (or updates) the chart with current data. This method is called from the XZoomableChartBase base class (from createChart method, which is called from this.componentDidUpdate)
     */
    createChart(base, forceRefresh, updateZoom, xScale, yScale, xSize, ySize) {
        /** @description last data loaded by fetchData */
        const signalSetData = this.state.signalSetData;

        if (!signalSetData)
            return RenderStatus.NO_DATA;
        if (!forceRefresh && !updateZoom)
            return RenderStatus.SUCCESS;

        this.drawBars(signalSetData, this.barsSelection, xScale, yScale, d3Color.color(this.props.config.color), false);

        // we don't want to change the cursor area when updating only zoom (it breaks touch drag)
        if (forceRefresh)
            this.createChartCursorArea(xSize, ySize);

        this.createChartCursor(signalSetData, xScale, yScale, xSize, ySize);

        return RenderStatus.SUCCESS;
    }

    // noinspection JSCommentMatchesSignature
    /**
     * @param data                  data in format as produces by this.prepareData
     * @param selection             d3 selection to which the data will get assigned and drawn
     * @param disableTransitions    animations when bars are created or modified
     */
    drawBars(data, selection, xScale, yScale, barColor, disableTransitions = true) {
        const step = data.step;
        const barWidth = xScale(step) - xScale(0) - 1;
        const ySize = yScale.range()[0];

        const bars = selection
            .selectAll('rect')
            .data(data.buckets, d => d.key);

        const allBars = bars.enter()
            .append('rect')
            .attr('y', yScale.range()[0])
            .attr("height", 0)
            .merge(bars);

        allBars.attr('x', d => xScale(d.key))
            .attr("width", barWidth)
            .attr("fill", barColor);
        (disableTransitions || !this.props.withTransition ?  allBars : allBars.transition())
            .attr('y', d => yScale(d.prob))
            .attr("height", d => ySize - yScale(d.prob));

        bars.exit()
            .remove();
    }

    /** Prepares the rectangle for cursor movement events.
     *  Called from this.createChart(). */
    createChartCursorArea(xSize, ySize) {
        this.cursorAreaSelection
            .selectAll('rect')
            .remove();

        this.cursorAreaSelection
            .append('rect')
            .attr('pointer-events', 'all')
            .attr('cursor', 'crosshair')
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', xSize)
            .attr('height', ySize)
            .attr('visibility', 'hidden');
    }

    /** Handles mouse movement to select the closest bar (for displaying its details in Tooltip, etc.).
     *  Called from this.createChart(). */
    createChartCursor(signalSetData, xScale, yScale, xSize, ySize) {
        const self = this;
        const highlightBarColor = d3Color.color(this.props.config.color).darker();

        this.barsHighlightSelection
            .selectAll('rect')
            .remove();

        let selection, mousePosition;

        const selectPoints = function () {
            if (self.state.zoomInProgress)
                return;

            const containerPos = d3Selection.mouse(self.cursorAreaSelection.node());
            const x = containerPos[0];

            const key = xScale.invert(x);
            let newSelection = null;
            if (isInExtent(key, [self.state.signalSetData.min, self.state.signalSetData.max])) {
                for (const bucket of signalSetData.buckets) {
                    if (bucket.key <= key) {
                        newSelection = bucket;
                    } else {
                        break;
                    }
                }
            }
            else {
                self.deselectPoints();
            }

            if (selection !== newSelection && newSelection !== null && (self.props.withCursor || self.props.withTooltip)) {
                self.drawBars({
                    buckets: [newSelection],
                    step: signalSetData.step
                }, self.barsHighlightSelection, xScale, yScale, highlightBarColor)
            }

            self.cursorSelection
                .attr('y1', 0)
                .attr('y2', ySize)
                .attr('x1', containerPos[0])
                .attr('x2', containerPos[0])
                .attr('visibility', self.props.withCursor ? 'visible' : "hidden");

            selection = newSelection;
            mousePosition = {x: containerPos[0], y: containerPos[1]};

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

    /** Called when mouse leaves the chart. Hides the Tooltip, etc. */
    deselectPoints() {
        this.cursorSelection.attr('visibility', 'hidden');

        this.barsHighlightSelection
            .selectAll('rect')
            .remove();

        this.setState({
            selection: null,
            mousePosition: null
        });
    }

    /** Returns the current view (boundaries of visible region)
     * @return {{xMin: number, xMax: number }} left, right boundary
     */
    getView() {
        return this.base.getView();
    }

    /**
     * Set the visible region of the chart to defined limits (in units of the data, not in pixels)
     * @param xMin          left boundary of the visible region (in units of data on x-axis)
     * @param xMax          right boundary of the visible region (in units of data on x-axis)
     * @param source        the element which caused the view change (if source === this, the update is ignored)
     * @param causedByUser  tells whether the view update was caused by user (this propagates to props.viewChangeCallback call), default = false
     */
    setView(xMin, xMax, source, causedByUser = false) {
        if (source === this || this.state.signalSetData === null)
            return;
        if (this.base)
            this.base.setView(xMin, xMax, source, causedByUser);
    }

    /** Draws an additional histogram to the overview (see XZoomableChartBase.createChartOverview) below the main chart
     *  Called from XZoomableChartBase.createChart(). */
    createChartOverview(base, xScale, xSize, ySize) {
        /** @description data loaded when chart was completely zoomed out - displayed by overview */
        const globalSignalSetData = this.state.globalSignalSetData;
        if (!globalSignalSetData) return;

        const yScale = d3Scale.scaleLinear()
            .domain([0, globalSignalSetData.maxProb])
            .range([ySize, 0]);

        this.drawBars(globalSignalSetData, this.overviewBarsSelection, xScale, yScale, d3Color.color(this.props.config.color));
    }

    getGraphContent(base, xScale, yScale, xSize, ySize) {
        return (<>
            <g ref={node => this.barsSelection = select(node)}/>
            <g ref={node => this.barsHighlightSelection = select(node)}/>

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

    getOverviewContent() {
        return (
            <g ref={node => this.overviewBarsSelection = select(node)}/>
        );
    }

    render() {
        return (
            <XZoomableChartBase
                ref={node => this.base = node}

                height={this.props.height}
                margin={this.props.margin}
                withOverviewX={this.props.withOverview}
                overviewHeight={this.props.overviewHeight}
                overviewMargin={this.props.overviewMargin}
                withTransition={this.props.withTransition}
                withZoom={this.props.withZoom}
                withBrush={this.props.withBrush}

                getXScale={::this.getXScale}
                getYScale={::this.getYScale}
                statusMsg={this.state.statusMsg}

                createChart={::this.createChart}
                createChartOverview={::this.createChartOverview}
                prepareChart={::this.prepareChart}
                getGraphContent={::this.getGraphContent}
                getOverviewContent={::this.getOverviewContent}
                onZoomEnd={::this.deselectPoints}

                yAxisTicksFormat={this.getYScale([0,0]).tickFormat(10, "-%")}
                xAxisTicksCount={this.props.xAxisTicksCount}
                xAxisTicksFormat={this.props.xAxisTicksFormat}
                xAxisLabel={this.props.xAxisLabel}
                viewChangeCallback={this.props.viewChangeCallback}
                zoomLevelMin={this.props.zoomLevelMin}
                zoomLevelMax={this.props.zoomLevelMax}
                className={this.props.className}
                style={this.props.style}
            />
        );
    }
}
