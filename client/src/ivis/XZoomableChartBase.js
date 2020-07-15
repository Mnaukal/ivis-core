'use strict';

import React, {Component} from "react";
import * as d3Axis from "d3-axis";
import {event as d3Event, select} from "d3-selection";
import * as d3Zoom from "d3-zoom";
import * as d3Brush from "d3-brush";
import {withErrorHandling} from "../lib/error-handling";
import PropTypes from "prop-types";
import {withComponentMixins} from "../lib/decorator-helpers";
import {withTranslation} from "../lib/i18n";
import styles from "./CorrelationCharts.scss";
import {
    brushHandlesLeftRight,
    RenderStatus,
    transitionInterpolate,
    WheelDelta,
    ZoomEventSources
} from "./common";

/**
 * Base class for charts with horizontal zoom.
 */
@withComponentMixins([
    withTranslation,
    withErrorHandling
], ["getView", "setView", "getZoomTransform", "resetZoom", "createChart", "callViewChangeCallback", "setBrushEnabled"])
export class XZoomableChartBase extends Component {
    constructor(props){
        super(props);

        const t = props.t;

        this.state = {
            zoomTransform: d3Zoom.zoomIdentity,
            width: 0,
            brushInProgress: false,
        };

        this.xSize = 0;
        this.ySize = 0;

        this.zoom = null;
        this.brushX = null;
        this.lastZoomCausedByUser = false;

        this.resizeListener = () => {
            this.createChart(true);
        };
    }

    static propTypes = {
        height: PropTypes.number.isRequired,
        margin: PropTypes.object,

        withOverviewX: PropTypes.bool,
        withOverviewXBrush: PropTypes.bool,
        overviewHeight: PropTypes.number,
        overviewMargin: PropTypes.object,

        withTransition: PropTypes.bool,
        withZoom: PropTypes.bool,
        withBrush: PropTypes.bool,

        getXScale: PropTypes.func.isRequired,
        getYScale: PropTypes.func, // can be called repeatedly
        statusMsg: PropTypes.string,

        createChart: PropTypes.func.isRequired, // createChart(base, forceRefresh, updateZoom, updated_xScale, yScale, xSize, ySize)
        createChartOverview: PropTypes.func, // createChartOverview(base, original_xScale, xSize, overview_ySize)
        prepareChart: PropTypes.func, // prepareChart(base, forceRefresh, updateZoom, updated_xScale, xSize, ySize) - called before the props.createChart so that the data can be filtered and the yScale in the createChart method call corresponds to the filtered data
        getGraphContent: PropTypes.func.isRequired, // getGraphContent(base, updated_xScale, yScale, xSize, ySize)
        getOverviewContent: PropTypes.func, // getOverviewContent(base, original_xScale, xSize, overview_ySize)
        getSvgDefs: PropTypes.func, // getSvgDefs(base, xScale, yScale, xSize, ySize)
        getOverviewSvgDefs: PropTypes.func, // getOverviewSvgDefs(base, original_xScale, xSize, overview_ySize)

        onZoomStart: PropTypes.func,
        onZoom: PropTypes.func,
        onZoomEnd: PropTypes.func,

        xAxisTicksCount: PropTypes.number,
        xAxisTicksFormat: PropTypes.func,
        xAxisLabel: PropTypes.string,
        yAxisTicksCount: PropTypes.number,
        yAxisTicksFormat: PropTypes.func,
        yAxisLabel: PropTypes.string,

        viewChangeCallback: PropTypes.func,

        zoomLevelMin: PropTypes.number,
        zoomLevelMax: PropTypes.number,
        zoomLevelWheelDelta: PropTypes.number,

        className: PropTypes.string,
        style: PropTypes.object,
    };

    static defaultProps = {
        margin: { left: 40, right: 5, top: 5, bottom: 40 },

        withOverviewX: true,
        withOverviewXBrush: true,
        withTransition: true,
        withZoom: true,
        withBrush: true,

        zoomLevelMin: 1,
        zoomLevelMax: 4,
        zoomLevelWheelDelta: 2,

        overviewHeight: 50,
        overviewMargin: { top: 0, bottom: 0 },

        getOverviewContent: () => null,
        getSvgDefs: () => null,
        getOverviewSvgDefs: () => null,
        getYScale: () => null,
        statusMsg: "",
    };

    componentDidMount() {
        window.addEventListener('resize', this.resizeListener);
        window.addEventListener('keydown', ::this.keydownListener);
        window.addEventListener('keyup', ::this.keyupListener);
        this.createChart(false, false);
    }

    /** Update and redraw the chart based on changes in React props and state */
    componentDidUpdate(prevProps, prevState) {
        const forceRefresh = this.prevContainerNode !== this.containerNode || prevState.brushInProgress !== this.state.brushInProgress;
        const updateZoom = !Object.is(prevState.zoomTransform, this.state.zoomTransform);

        this.createChart(forceRefresh, updateZoom);
        this.prevContainerNode = this.containerNode;
        if (updateZoom)
            this.callViewChangeCallback();
    }

    componentWillUnmount() {
        window.removeEventListener('resize', this.resizeListener);
        window.removeEventListener('keydown', ::this.keydownListener);
        window.removeEventListener('keyup', ::this.keyupListener);
    }

    /** Creates (or updates) the chart with current data.
     * This method is called from componentDidUpdate automatically when state or config is updated or can be called from outside (from the component which is built on this base class).
     * It first computes the size of the chart and then calls the prepareChart and createChart methods from props with xScale updated by the zoom.
     * - The prepareChart method can be used to update the data according to the new xScale, so that the yScale used in the createChart method corresponds to the new data. See HistogramChart as an example.
     **/
    createChart(forceRefresh, updateZoom) {
        const width = this.containerNode.getClientRects()[0].width;
        const widthChanged = width !== this.state.width;
        if (widthChanged)
            this.setState({width});

        const ySize = this.props.height - this.props.margin.top - this.props.margin.bottom;
        this.ySize = ySize;
        const xSize = width - this.props.margin.left - this.props.margin.right;
        this.xSize = xSize;

        // update xScale with zoom, draw it later; sets this.xScale
        this.updateXScale(xSize);

        // prepare the data in the child - update it according to the new xScale
        if (this.props.prepareChart)
            this.props.prepareChart(this, forceRefresh || widthChanged, updateZoom, this.xScale, xSize, ySize);

        // get yScale
        this.yScale = this.props.getYScale(/* range: */ [this.ySize, 0]);

        // everything is prepared, now call the createChart method of the child
        const renderStatus = this.props.createChart(this, forceRefresh || widthChanged, updateZoom, this.xScale, this.yScale, xSize, ySize);
        if (renderStatus !== this.state.renderStatus)
            this.setState({renderStatus});
        if (renderStatus === RenderStatus.NO_DATA)
            return;

        // draw the axes - update the yScale before drawing it - it might have changed in this.props.createChart
        this.drawXAxis();
        this.drawYAxis();

        // and the rest of the chart
        if (this.props.withOverviewX) {
            this.createChartOverviewX(xSize);
        }
        // we don't want to change zoom object when updating only zoom (it breaks touch drag)
        if ((forceRefresh || widthChanged) && this.props.withZoom)
            this.createChartZoom(xSize, ySize);
        if (this.props.withBrush) {
            this.createChartBrush(xSize, ySize);
        }
    }

    updateXScale(xSize) {
        let xScale = this.props.getXScale(/* range: */ [0, xSize]);
        this.originalXScale = xScale;

        if (typeof xScale.invert === "function")
            this.xScale = this.state.zoomTransform.rescaleX(xScale);
        else
            this.xScale = xScale.copy().range(xScale.range().map(d => this.state.zoomTransform.applyX(d)))
    }

    drawXAxis() {
        const xAxis = d3Axis.axisBottom(this.xScale)
            .tickSizeOuter(0);
        if (this.props.xAxisTicksCount) xAxis.ticks(this.props.xAxisTicksCount);
        if (this.props.xAxisTicksFormat) xAxis.tickFormat(this.props.xAxisTicksFormat);
        this.xAxisSelection.call(xAxis); // no transition for xAxis as it is updated by zoom (animation would delay the rendering)
        this.xAxisLabelSelection.text(this.props.xAxisLabel).style("text-anchor", "middle");
    }

    drawYAxis() {
        if (this.yScale === null || this.yScale === undefined) return;
        const yAxis = d3Axis.axisLeft(this.yScale);
        if (this.props.yAxisTicksCount) yAxis.ticks(this.props.yAxisTicksCount);
        if (this.props.yAxisTicksFormat) yAxis.tickFormat(this.props.yAxisTicksFormat);
        (this.props.withTransition ? this.yAxisSelection.transition() : this.yAxisSelection)
            .call(yAxis);
        this.yAxisLabelSelection.text(this.props.yAxisLabel).style("text-anchor", "middle");
    }

    /** Handles zoom of the chart by user using d3-zoom.
     *  Called from this.createChart(). */
    createChartZoom(xSize, ySize) {
        const self = this;

        const handleZoom = function () {
            // noinspection JSUnresolvedVariable
            if (self.props.withTransition && d3Event.sourceEvent && d3Event.sourceEvent.type === "wheel") {
                self.lastZoomCausedByUser = true;
                transitionInterpolate(select(self), self.state.zoomTransform, d3Event.transform, setZoomTransform, () => {
                    if (typeof self.props.onZoomEnd === 'function') self.props.onZoomEnd();
                });
            } else {
                // noinspection JSUnresolvedVariable
                if (d3Event.sourceEvent && ZoomEventSources.includes(d3Event.sourceEvent.type))
                    self.lastZoomCausedByUser = true;
                // noinspection JSUnresolvedVariable
                setZoomTransform(d3Event.transform);
            }
        };

        const setZoomTransform = function (transform) {
            self.setState({
                zoomTransform: transform
            });
            self.moveBrush(transform);
            if (typeof self.props.onZoom === 'function') self.props.onZoom(d3Event, transform);
        };

        const handleZoomEnd = function () {
            self.setState({
                zoomInProgress: false
            });
            if (typeof self.props.onZoomEnd === 'function') self.props.onZoomEnd(d3Event);
        };
        const handleZoomStart = function () {
            self.setState({
                zoomInProgress: true
            });
            if (typeof self.props.onZoomStart === 'function') self.props.onZoomStart(d3Event);
        };

        const zoomExtent = [[0,0], [xSize, ySize]];
        const zoomExisted = this.zoom !== null;
        this.zoom = zoomExisted ? this.zoom : d3Zoom.zoom();
        this.zoom
            .scaleExtent([this.props.zoomLevelMin, this.props.zoomLevelMax])
            .translateExtent(zoomExtent)
            .extent(zoomExtent)
            .on("zoom", handleZoom)
            .on("end", handleZoomEnd)
            .on("start", handleZoomStart)
            .wheelDelta(WheelDelta(this.props.zoomLevelWheelDelta));
        this.svgContainerSelection.call(this.zoom);
        this.moveBrush(this.state.zoomTransform);
    }

    /** Returns the current zoomTransform (https://github.com/d3/d3-zoom#zoom-transforms) */
    getZoomTransform() {
        return this.state.zoomTransform;
    }

    /** Returns the current view (boundaries of visible region)
     * @return {{xMin: number, xMax: number }} left, right boundary
     */
    getView() {
        const [xMin, xMax] = this.xScale.domain();
        return {xMin, xMax};
    }

    /**
     * Set the visible region of the chart to defined limits (in units of the data, not in pixels)
     * @param xMin          left boundary of the visible region (in units of data on x-axis)
     * @param xMax          right boundary of the visible region (in units of data on x-axis)
     * @param source        the element which caused the view change (if source === this, the update is ignored)
     * @param causedByUser  tells whether the view update was caused by user (this propagates to props.viewChangeCallback call), default = false
     */
    setView(xMin, xMax, source, causedByUser = false) {
        if (source === this || this.state.renderStatus === RenderStatus.NO_DATA)
            return;

        if (xMin === undefined) xMin = this.xScale.domain()[0];
        if (xMax === undefined) xMax = this.xScale.domain()[1];

        if (isNaN(xMin) || isNaN(xMax))
            throw new Error("Parameters must be numbers.");

        this.lastZoomCausedByUser = causedByUser;
        this.setZoomToLimits(xMin, xMax);
    }

    /** Sets zoom object (transform) to desired view boundaries. */
    setZoomToLimits(xMin, xMax) { // TODO non-numerical signals
        if (this.brush) {
            this.overviewBrushSelection.call(this.brush.move, [this.originalXScale(xMin), this.originalXScale(xMax)]);
            // brush will also adjust zoom if sourceEvent is not "zoom" caused by this.zoom which is true when this method is called from this.setView
        }
        else {
            const newXSize = xMax - xMin;
            const oldXSize = this.xScale.domain()[1] - this.xScale.domain()[0];

            const leftInverted = this.state.zoomTransform.invertX(this.xScale(xMin));
            const transform = d3Zoom.zoomIdentity.scale(this.state.zoomTransform.k * oldXSize / newXSize).translate(-leftInverted, 0);

            this.setZoom(transform);
        }
    }

    /** Sets zoom object (transform) to desired view boundaries in pixels. */
    setZoomToPixels(left, right) {
        if (left >= 0 && right <= this.xSize) {
            if (this.brushX) {
                this.overviewBrushSelection.call(this.brushX.move, [this.state.zoomTransform.invertX(left), this.state.zoomTransform.invertX(right)]);
                // brush will also adjust zoom if sourceEvent is not "zoom" caused by this.zoom which is true when this method is called from this.setView
            } else {
                const newXSize = right - left;
                const leftInverted = this.state.zoomTransform.invertX(left);
                const transform = d3Zoom.zoomIdentity.scale(this.state.zoomTransform.k * this.xSize / newXSize).translate(-leftInverted, 0);

                this.setZoom(transform);
            }
        }
    }

    /**
     * Resets the visible region of the chart to the initial
     * @param causedByUser  tells whether the view update was caused by user (this propagates to props.viewChangeCallback call), default = false
     */
    resetZoom(causedByUser = false) {
        this.lastZoomCausedByUser = causedByUser;
        this.setZoom(d3Zoom.zoomIdentity);
    }

    /** Helper method to update zoom transform in state and zoom object. */
    setZoom(transform) {
        if (this.zoom)
            this.svgContainerSelection.call(this.zoom.transform, transform);
        else {
            this.setState({zoomTransform: transform});
            this.moveBrush(transform);
        }
    }

    /** Updates overview brushes from zoom transform. */
    moveBrush(transform) {
        if (this.brushX)
            this.overviewBrushSelection.call(this.brushX.move, this.defaultBrush.map(transform.invertX, transform));
    };

    /**
     * Calls the props.viewChangeCallback method
     */
    callViewChangeCallback() {
        if (typeof(this.props.viewChangeCallback) !== "function")
            return;

        this.props.viewChangeCallback(this, this.getView(), this.lastZoomCausedByUser);
    }

    /** Creates d3-brush for overview.
     *  Called from this.createChart(). */
    createChartOverviewX(xSize) {
        const self = this;

        // axis
        if (this.props.overviewMargin.bottom > 0) {
            const xAxis = d3Axis.axisBottom(this.originalXScale)
                .tickSizeOuter(0);
            if (this.props.xAxisTicksCount) xAxis.ticks(this.props.xAxisTicksCount);
            if (this.props.xAxisTicksFormat) xAxis.tickFormat(this.props.xAxisTicksFormat);
            this.overviewXAxisSelection.call(xAxis);
        }

        // brush
        const overviewX_ySize = this.props.overviewHeight - this.props.overviewMargin.top - this.props.overviewMargin.bottom;
        this.overviewX_ySize = overviewX_ySize;

        if (this.props.withOverviewXBrush) {
            this.defaultBrush = [0, xSize];
            const brushExisted = this.brushX !== null;
            this.brushX = brushExisted ? this.brushX : d3Brush.brushX(); // this is permanent brush in the overview
            this.brushX
                .extent([[0, 0], [xSize, overviewX_ySize]])
                .handleSize(20)
                .on("brush", function () {
                    // noinspection JSUnresolvedVariable
                    const sel = d3Event.selection;
                    self.overviewBrushSelection.call(brushHandlesLeftRight, sel, overviewX_ySize);

                    // noinspection JSUnresolvedVariable
                    if (d3Event.sourceEvent && d3Event.sourceEvent.type === "zoom" && d3Event.sourceEvent.target === self.zoom) return; // ignore brush-by-zoom
                    // noinspection JSUnresolvedVariable
                    if (d3Event.sourceEvent && d3Event.sourceEvent.type === "brush" && d3Event.sourceEvent.target === self.brushX) return; // ignore brush by itself

                    // noinspection JSUnresolvedVariable
                    if (d3Event.sourceEvent && ZoomEventSources.includes(d3Event.sourceEvent.type))
                        self.lastZoomCausedByUser = true;

                    const newTransform = d3Zoom.zoomIdentity.scale(xSize / (sel[1] - sel[0])).translate(-sel[0], 0);
                    self.setZoom(newTransform);
                });

            this.overviewBrushSelection
                .attr('pointer-events', 'all')
                .call(this.brushX);
            if (!brushExisted)
                this.overviewBrushSelection.call(this.brushX.move, this.defaultBrush);
            this.overviewBrushSelection.select(".selection")
                .classed(styles.selection, true);
            this.overviewBrushSelection.select(".overlay")
                .attr('pointer-events', 'none');
        }

        // call createChartOverview method in child to update the overview
        if (this.props.createChartOverview)
            this.props.createChartOverview(this, this.originalXScale, xSize, overviewX_ySize);
    }

    //<editor-fold desc="Brush in the main chart area (only when CTRL is held)">
    keydownListener(event) {
        if (event.key === "Control")
            this.setBrushEnabled(true);
    }
    keyupListener(event) {
        if (event.key === "Control" && !this.state.zoomInProgress)
            this.setBrushEnabled(false);
    }

    setBrushEnabled(enabled) {
        if (this.state.brushInProgress !== enabled)
            this.setState({ brushInProgress: enabled });
    }

    /** Prepares the d3 brush for region selection.
     *  Called from this.createChart(). */
    createChartBrush(xSize, ySize) {
        const self = this;

        if (this.state.brushInProgress) {
            const brush = d3Brush.brushX()
                .extent([[0, 0], [xSize, ySize]])
                .filter(() => {
                    // noinspection JSUnresolvedVariable
                    return !d3Event.button // enable brush when ctrl is pressed, modified version of default brush filter (https://github.com/d3/d3-brush#brush_filter)
                })
                .on("start", function () {
                    self.setState({ zoomInProgress: true });
                })
                .on("end", function () {
                    // noinspection JSUnresolvedVariable
                    const sel = d3Event.selection;
                    if (sel) {
                        self.lastZoomCausedByUser = true;
                        self.setZoomToPixels(sel[0], sel[1]);

                        // hide brush
                        self.brushSelection.call(brush.move, null);
                        self.setState({
                            brushInProgress: false,
                            zoomInProgress: false
                        });
                    }
                });

            this.brushSelection
                .attr('pointer-events', 'all')
                .call(brush);
        }
        else {
            this.brushParentSelection
                .selectAll('rect')
                .remove();
            this.brushSelection
                .attr('pointer-events', 'none');
        }
    }
    //</editor-fold>

    render() {
        if (this.state.renderStatus === RenderStatus.NO_DATA) {
            return (
                <svg ref={node => this.containerNode = node} height={this.props.height} width="100%"
                     className={this.props.className} style={this.props.style} >
                    <text textAnchor="middle" x="50%" y="50%" fontFamily="'Open Sans','Helvetica Neue',Helvetica,Arial,sans-serif" fontSize="14px">
                        {this.props.statusMsg}
                    </text>
                </svg>
            );
        } else {
            return (
                <div className={this.props.className} style={this.props.style} >
                    <div ref={node => this.svgContainerSelection = select(node)} className={styles.touchActionPanY} >
                        <svg id="cnt" ref={node => this.containerNode = node} height={this.props.height} width="100%">
                            {this.props.getSvgDefs(this, this.xScale, this.yScale, this.xSize, this.ySize)}
                            <defs>
                                <clipPath id="plotRect">
                                    <rect x="0" y="0" width={this.state.width - this.props.margin.left - this.props.margin.right} height={this.props.height - this.props.margin.top - this.props.margin.bottom} />
                                </clipPath>
                                <clipPath id="bottomAxis">
                                    <rect x={-6} y={0} width={this.state.width - this.props.margin.left - this.props.margin.right + 6}
                                          height={this.props.margin.bottom} /* same reason for 6 as in HeatmapChart */ />
                                </clipPath>
                            </defs>
                            <g /* Graph content */ transform={`translate(${this.props.margin.left}, ${this.props.margin.top})`} clipPath="url(#plotRect)" >
                                {this.props.getGraphContent(this, this.xScale, this.yScale, this.xSize, this.ySize)}
                            </g>

                            {/* axes */}
                            <g ref={node => this.xAxisSelection = select(node)} transform={`translate(${this.props.margin.left}, ${this.props.height - this.props.margin.bottom})`} clipPath="url(#bottomAxis)" />
                            <text ref={node => this.xAxisLabelSelection = select(node)}
                                  transform={`translate(${this.props.margin.left + (this.state.width - this.props.margin.left - this.props.margin.right) / 2}, ${this.props.height - 5})`} />

                            <g ref={node => this.yAxisSelection = select(node)} transform={`translate(${this.props.margin.left}, ${this.props.margin.top})`}/>
                            <text ref={node => this.yAxisLabelSelection = select(node)}
                                  transform={`translate(${15}, ${this.props.margin.top + (this.props.height - this.props.margin.top - this.props.margin.bottom) / 2}) rotate(-90)`} />

                            <g ref={node => this.brushParentSelection = select(node)}
                               transform={`translate(${this.props.margin.left}, ${this.props.margin.top})`} >
                                <g ref={node => this.brushSelection = select(node)} />
                            </g>
                        </svg>
                    </div>
                    {this.props.withOverviewX &&
                    <svg id="overview" height={this.props.overviewHeight}
                         width="100%">
                        {this.props.getOverviewSvgDefs(this)}
                        <defs>
                            <clipPath id="overviewRect">
                                <rect x="0" y="0" width={this.state.width - this.props.margin.left - this.props.margin.right} height={this.props.overviewHeight - this.props.overviewMargin.top - this.props.overviewMargin.bottom} />
                            </clipPath>
                        </defs>
                        <g transform={`translate(${this.props.margin.left}, ${this.props.overviewMargin.top})`} clipPath="url(#plotRect)" >
                            {this.props.getOverviewContent(this, this.originalXScale, this.xSize, this.overviewX_ySize)}
                        </g>
                        <g ref={node => this.overviewXAxisSelection = select(node)}
                           transform={`translate(${this.props.margin.left}, ${this.props.overviewHeight - this.props.overviewMargin.bottom})`}/>
                        <g ref={node => this.overviewBrushSelection = select(node)}
                           transform={`translate(${this.props.margin.left}, ${this.props.overviewMargin.top})`}
                           className={styles.brush}/>
                    </svg>}
                </div>
            );
        }
    }
}
