'use strict';

import React, {Component} from "react";
import * as d3Axis from "d3-axis";
import {event as d3Event, select} from "d3-selection";
import * as d3Zoom from "d3-zoom";
import * as d3Brush from "d3-brush";
import * as d3Interpolate from "d3-interpolate";
import {withErrorHandling} from "../lib/error-handling";
import PropTypes from "prop-types";
import {withComponentMixins} from "../lib/decorator-helpers";
import {withTranslation} from "../lib/i18n";
import styles from "./CorrelationCharts.scss";
import {
    brushHandlesLeftRight, brushHandlesTopBottom,
    RenderStatus,
    ZoomEventSources
} from "./common";

/**
 * Base class for charts with horizontal zoom.
 */
@withComponentMixins([
    withTranslation,
    withErrorHandling
], ["getView", "setView", "getXZoomTransform", "getYZoomTransform", "resetZoom", "createChart", "callViewChangeCallback", "setBrushEnabled"])
export class ZoomableChartBase extends Component {
    constructor(props){
        super(props);

        this.state = {
            viewX: [0, 0],
            viewY: [0, 0],
            width: 0,
            brushInProgress: false,
        };

        this.xSize = 0;
        this.ySize = 0;

        this.zoom = null;
        this.brush = null;
        // overview brushes
        this.brushX = null;
        this.brushY = null;

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
        overviewXHeight: PropTypes.number,
        overviewXMargin: PropTypes.object,

        withOverviewY: PropTypes.bool,
        withOverviewYBrush: PropTypes.bool,
        overviewYWidth: PropTypes.number,
        overviewYMargin: PropTypes.object,

        withTransition: PropTypes.bool,
        withZoomX: PropTypes.bool,
        withZoomY: PropTypes.bool,
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
        withOverviewY: true,
        withOverviewYBrush: true,
        withTransition: true,
        withZoomX: true,
        withZoomY: true,
        withBrush: true,

        zoomLevelMin: 1,
        zoomLevelMax: 4,
        zoomLevelWheelDelta: 2,

        overviewXHeight: 50,
        overviewXMargin: { top: 0, bottom: 0 },
        overviewYWidth: 50,
        overviewYMargin: { left: 0, right: 0 },

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
        const forceRefresh =
            this.prevContainerNode !== this.containerNode ||
            prevState.brushInProgress !== this.state.brushInProgress;
        const updateZoom = !Object.is(prevState.viewX, this.state.viewX) || !Object.is(prevState.viewY, this.state.viewY);

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
     * It first computes the size of the chart and then calls the prepareChart and createChart methods from props with the xScale and yScale updated by the zoom.
     * - If only one of the axes is zoomed, the prepareChart method can be used to update the data according to the updated scale, so that the other scale used in the createChart method corresponds to the new data.
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
        this.updateYScale(ySize);

        // prepare the data in the child - update it according to the new xScale
        if (this.props.prepareChart)
            this.props.prepareChart(this, forceRefresh || widthChanged, updateZoom, this.xScale, xSize, ySize);

        // if zoom is enabled for only one axis, get the other scale as it could be altered by the props.prepareChart method
        if (!this.props.withZoomY && !this.props.withOverviewYBrush)
            this.yScale = this.props.getYScale(/* range: */ [this.ySize, 0]);
        if (!this.props.withZoomX && !this.props.withOverviewXBrush)
            this.xScale = this.props.getXScale(/* range: */ [0, this.xSize]);

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
        if (this.props.withOverviewX)
            this.createChartOverviewX(xSize);
        if (this.props.withOverviewY)
            this.createChartOverviewY(ySize);

        // we don't want to change zoom object when updating only zoom (it breaks touch drag)
        //if ((forceRefresh || widthChanged) && (this.props.withZoomX || this.props.withZoomY))
        //    this.createChartZoom(xSize, ySize);
        if (this.props.withBrush)
            this.createChartBrush(xSize, ySize);
    }

    updateXScale(xSize) {
        let xScale = this.props.getXScale(/* range: */ [0, xSize]);
        this.originalXScale = xScale;

        if (typeof xScale.invert === "function")
            this.xScale = this.getXZoomTransform().rescaleX(xScale);
        else
            this.xScale = xScale.copy().range(xScale.range().map(d => this.state.zoomTransform.applyX(d)))
    }

    updateYScale(ySize) {
        let yScale = this.props.getYScale(/* range: */ [ySize, 0]);
        this.originalYScale = yScale;

        if (typeof yScale.invert === "function")
            this.yScale = this.getYZoomTransform().rescaleY(yScale);
        else
            this.yScale = yScale.copy().range(yScale.range().map(d => this.getYZoomTransform().applyY(d)))
    }

    drawXAxis() {
        if (this.xScale === null || this.xScale === undefined) return;
        const xAxis = d3Axis.axisBottom(this.xScale)
            .tickSizeOuter(0);
        if (this.props.xAxisTicksCount) xAxis.ticks(this.props.xAxisTicksCount);
        if (this.props.xAxisTicksFormat) xAxis.tickFormat(this.props.xAxisTicksFormat);
        this.xAxisSelection.call(xAxis);
        this.xAxisLabelSelection.text(this.props.xAxisLabel).style("text-anchor", "middle");
    }

    drawYAxis() {
        if (this.yScale === null || this.yScale === undefined) return;
        const yAxis = d3Axis.axisLeft(this.yScale);
        if (this.props.yAxisTicksCount) yAxis.ticks(this.props.yAxisTicksCount);
        if (this.props.yAxisTicksFormat) yAxis.tickFormat(this.props.yAxisTicksFormat);
        this.yAxisSelection.call(yAxis);
        this.yAxisLabelSelection.text(this.props.yAxisLabel).style("text-anchor", "middle");
    }

    /** Returns the current zoomTransform for x-axis (https://github.com/d3/d3-zoom#zoom-transforms) */
    getXZoomTransform() {
        const newSize = this.state.viewX[1] - this.state.viewX[0];
        return d3Zoom.zoomIdentity.scale(this.xSize / newSize).translate(-this.state.viewX[0], 0);
    }

    /** Returns the current zoomTransform for y-axis (https://github.com/d3/d3-zoom#zoom-transforms) */
    getYZoomTransform() {
        const newSize = this.state.viewY[1] - this.state.viewY[0];
        return d3Zoom.zoomIdentity.scale(this.ySize / newSize).translate(0, -this.state.viewY[0]);
    }

    getBrushValuesFromZoomValues(transform, zoomYScaleMultiplier) {
        let updated = false;
        let newBrushX = this.defaultBrushX.map(transform.invertX, transform);
        const yTransform = transform.scale(zoomYScaleMultiplier);
        let newBrushY = this.defaultBrushY.map(yTransform.invertY, yTransform);

        if (this.props.withZoomX && this.props.withZoomY) {
            if (newBrushX[0] < this.defaultBrushX[0]) {
                newBrushX[0] = this.defaultBrushX[0];
                updated = true;
            }
            if (newBrushX[1] > this.defaultBrushX[1]) {
                newBrushX[1] = this.defaultBrushX[1];
                updated = true;
            }

            if (newBrushY[0] < this.defaultBrushY[0]) {
                newBrushY[0] = this.defaultBrushY[0];
                updated = true;
            }
            if (newBrushY[1] > this.defaultBrushY[1]) {
                newBrushY[1] = this.defaultBrushY[1];
                updated = true;
            }
        }
        else {
            // zoom disabled -> use values from brushes
            updated = true;
            if (!this.props.withZoomX) {
                newBrushX = this.brushXValues || this.defaultBrushX;
            }
            if (!this.props.withZoomY) {
                newBrushY = this.brushYValues || this.defaultBrushY;
            }
        }
        return [newBrushX, newBrushY, updated];
    }

    /** Returns the current view (boundaries of visible region)
     * @return {{xMin, xMax, yMin, yMax }} left, right, bottom, top boundary (numbers or strings based on the type of data on each axis)
     */
    getView() {
        const [xMin, xMax] = this.xScale.domain();
        const [yMin, yMax] = this.yScale.domain();
        return {xMin, xMax, yMin, yMax};
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
        if (source === this || this.state.renderStatus === RenderStatus.NO_DATA)
            return;

        // TODO

        if (xMin === undefined) xMin = this.xScale.domain()[0];
        if (xMax === undefined) xMax = this.xScale.domain()[1];

        if (isNaN(xMin) || isNaN(xMax))
            throw new Error("Parameters must be numbers.");

        this.lastZoomCausedByUser = causedByUser;
        this.setZoomToLimits(xMin, xMax);
    }

    /**
     * Resets the visible region of the chart to the initial
     * @param causedByUser  tells whether the view update was caused by user (this propagates to props.viewChangeCallback call), default = false
     */
    resetZoom(causedByUser = false) {
        this.lastZoomCausedByUser = causedByUser;

        if (this.brushX)
            this.overviewXBrushSelection.call(this.brushX.move, this.defaultBrushX);
        else
            this.updateXViewInState(0, this.xSize);

        if (this.brushY)
            this.overviewYBrushSelection.call(this.brushY.move, this.defaultBrushY);
        else
            this.updateYViewInState(0, this.ySize);
    }

    /**
     * Calls the props.viewChangeCallback method
     */
    callViewChangeCallback() {
        if (typeof(this.props.viewChangeCallback) !== "function")
            return;

        this.props.viewChangeCallback(this, this.getView(), this.lastZoomCausedByUser);
    }

    /** Sets the view along the x-axis (moves the brush). Argument values are in pixels, relative to the current view. */
    updateXView(left, right) {
        if (left >= 0 && right <= this.xSize && left < right) {
            left = this.getXZoomTransform().invertX(left);
            right = this.getXZoomTransform().invertX(right);

            if (this.brushX)
                this.overviewXBrushSelection.call(this.brushX.move, [left, right]);
            else
                this.updateXViewInState(left, right);
        }
    }

    /** Sets the view along the y-axis (moves the brush). Argument values are in pixels, relative to the current view. */
    updateYView(top, bottom) {
        if (top >= 0 && bottom <= this.ySize && top < bottom) {
            top = this.getYZoomTransform().invertY(top);
            bottom = this.getYZoomTransform().invertY(bottom);

            if (this.brushY)
                this.overviewYBrushSelection.call(this.brushY.move, [top, bottom]);
            else
                this.updateYViewInState(top, bottom);
        }
    }

    /** Helper function to update the state. */
    updateXViewInState(left, right) {
        if (left >= 0 && right <= this.xSize && left < right)
            if (this.state.viewX[0] !== left || this.state.viewX[1] !== right)
                this.setState({
                    viewX: [left, right]
                })
    }

    /** Helper function to update the state. */
    updateYViewInState(top, bottom) {
        if (top >= 0 && bottom <= this.ySize && top < bottom)
            if (this.state.viewY[0] !== top || this.state.viewY[1] !== bottom)
                this.setState({
                    viewY: [top, bottom]
                })
    }

    /** Creates d3-brush for X overview.
     *  Called from this.createChart(). */
    createChartOverviewX(xSize) {
        const self = this;

        // axis
        if (this.props.overviewXMargin.bottom > 0) {
            const xAxis = d3Axis.axisBottom(this.originalXScale)
                .tickSizeOuter(0);
            if (this.props.xAxisTicksCount) xAxis.ticks(this.props.xAxisTicksCount);
            if (this.props.xAxisTicksFormat) xAxis.tickFormat(this.props.xAxisTicksFormat);
            this.overviewXAxisSelection.call(xAxis);
        }

        // brush
        const overviewX_ySize = this.props.overviewXHeight - this.props.overviewXMargin.top - this.props.overviewXMargin.bottom;
        this.overviewX_ySize = overviewX_ySize;

        if (this.props.withOverviewXBrush) {
            this.defaultBrushX = [0, xSize];
            const brushExisted = this.brushX !== null;
            this.brushX = brushExisted ? this.brushX : d3Brush.brushX(); // this is permanent brush in the overview
            this.brushX
                .extent([[0, 0], [xSize, overviewX_ySize]])
                .handleSize(20)
                .on("brush", function () {
                    // noinspection JSUnresolvedVariable
                    const sel = d3Event.selection;
                    self.overviewXBrushSelection.call(brushHandlesLeftRight, sel, overviewX_ySize);

                    /*// noinspection JSUnresolvedVariable
                    if (d3Event.sourceEvent && d3Event.sourceEvent.type === "zoom" && d3Event.sourceEvent.target === self.zoom) return; // ignore brush-by-zoom
                    // noinspection JSUnresolvedVariable
                    if (d3Event.sourceEvent && d3Event.sourceEvent.type === "brush" && d3Event.sourceEvent.target === self.brushX) return; // ignore brush by itself*/

                    // noinspection JSUnresolvedVariable
                    if (d3Event.sourceEvent && ZoomEventSources.includes(d3Event.sourceEvent.type))
                        self.lastZoomCausedByUser = true;
                    self.updateXViewInState(...sel);
                });

            this.overviewXBrushSelection
                .attr('pointer-events', 'all')
                .call(this.brushX);
            if (!brushExisted)
                this.overviewXBrushSelection.call(this.brushX.move, this.defaultBrushX);
            this.overviewXBrushSelection.select(".selection")
                .classed(styles.selection, true);
            this.overviewXBrushSelection.select(".overlay")
                .attr('pointer-events', 'none');
        }

        // call createChartOverview method in child to update the overview
        if (this.props.createChartOverviewX)
            this.props.createChartOverviewX(this, this.originalXScale, xSize, overviewX_ySize);
    }

    /** Creates d3-brush for overview.
     *  Called from this.createChart(). */
    createChartOverviewY(ySize) {
        const self = this;

        // axis
        if (this.props.overviewYMargin.left > 0) {
            const yAxis = d3Axis.axisLeft(this.originalYScale)
                .tickSizeOuter(0);
            if (this.props.yAxisTicksCount) yAxis.ticks(this.props.yAxisTicksCount);
            if (this.props.yAxisTicksFormat) yAxis.tickFormat(this.props.yAxisTicksFormat);
            this.overviewYAxisSelection.call(yAxis);
        }

        // brush
        const overviewY_xSize = this.props.overviewYWidth - this.props.overviewYMargin.left - this.props.overviewYMargin.right;
        this.overviewY_xSize = overviewY_xSize;

        if (this.props.withOverviewYBrush) {
            this.defaultBrushY = [0, ySize];
            const brushExisted = this.brushY !== null;
            this.brushY = brushExisted ? this.brushY : d3Brush.brushY(); // this is permanent brush in the overview
            this.brushY
                .extent([[0, 0], [overviewY_xSize, ySize]])
                .handleSize(20)
                .on("brush", function () {
                    // noinspection JSUnresolvedVariable
                    const sel = d3Event.selection;
                    self.overviewYBrushSelection.call(brushHandlesTopBottom, sel, overviewY_xSize);

                    /*// noinspection JSUnresolvedVariable
                    if (d3Event.sourceEvent && d3Event.sourceEvent.type === "zoom" && d3Event.sourceEvent.target === self.zoom) return; // ignore brush-by-zoom
                    // noinspection JSUnresolvedVariable
                    if (d3Event.sourceEvent && d3Event.sourceEvent.type === "brush" && d3Event.sourceEvent.target === self.brushX) return; // ignore brush by itself*/

                    // noinspection JSUnresolvedVariable
                    if (d3Event.sourceEvent && ZoomEventSources.includes(d3Event.sourceEvent.type))
                        self.lastZoomCausedByUser = true;
                    self.updateYViewInState(...sel);
                });

            this.overviewYBrushSelection
                .attr('pointer-events', 'all')
                .call(this.brushY);
            if (!brushExisted)
                this.overviewYBrushSelection.call(this.brushY.move, this.defaultBrushY);
            this.overviewYBrushSelection.select(".selection")
                .classed(styles.selection, true);
            this.overviewYBrushSelection.select(".overlay")
                .attr('pointer-events', 'none');
        }

        // call createChartOverview method in child to update the overview
        if (this.props.createChartOverviewY)
            this.props.createChartOverviewY(this, this.originalYScale, overviewY_xSize, ySize);
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
            const brush = d3Brush.brush()
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
                        const [[x0, y0], [x1, y1]] = sel;
                        self.updateXView(x0, x1);
                        self.updateYView(y0, y1);

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
                    {this.props.withOverviewY &&
                    <svg id="overviewY" width={this.props.overviewYWidth} height={this.props.height} >
                        {this.props.getOverviewSvgDefs(this)}
                        <defs>
                            <clipPath id="overviewYRect">
                                <rect x="0" y="0" width={this.props.overviewYWidth - this.props.overviewYMargin.left - this.props.overviewYMargin.right} height={this.props.height - this.props.margin.top - this.props.margin.bottom} />
                            </clipPath>
                        </defs>
                        <g transform={`translate(${this.props.overviewYMargin.left}, ${this.props.margin.top})`} clipPath="url(#overviewYrect)" >
                            {this.props.getOverviewYContent(this, this.originalYScale, this.overviewY_xSize, this.ySize)}
                        </g>
                        <g ref={node => this.overviewYAxisSelection = select(node)}
                           transform={`translate(${this.props.overviewYMargin.left}, ${this.props.margin.top})`}/>
                        <g ref={node => this.overviewYBrushSelection = select(node)}
                           transform={`translate(${this.props.overviewYMargin.left}, ${this.props.margin.top})`}
                           className={styles.brush}/>
                    </svg>}

                    <div ref={node => this.svgContainerSelection = select(node)} className={styles.touchActionPanY}
                         style={{ width: this.props.withOverviewY ? `calc(100% - ${this.props.overviewYWidth}px)` : "100%", height: this.props.height, display: "inline-block"}} >
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
                    <svg id="overviewX"
                         height={this.props.overviewXHeight}
                         width={ this.props.withOverviewY ? `calc(100% - ${this.props.overviewYWidth}px)` : "100%"}
                         style={{marginLeft: this.props.withOverviewY ? this.props.overviewYWidth : 0}}>
                        {this.props.getOverviewSvgDefs(this)}
                        <defs>
                            <clipPath id="overviewXRect">
                                <rect x="0" y="0" width={this.state.width - this.props.margin.left - this.props.margin.right} height={this.props.overviewXHeight - this.props.overviewXMargin.top - this.props.overviewXMargin.bottom} />
                            </clipPath>
                        </defs>
                        <g transform={`translate(${this.props.margin.left}, ${this.props.overviewXMargin.top})`} clipPath="url(#overviewXRect)" >
                            {this.props.getOverviewXContent(this, this.originalXScale, this.xSize, this.overviewX_ySize)}
                        </g>
                        <g ref={node => this.overviewXAxisSelection = select(node)}
                           transform={`translate(${this.props.margin.left}, ${this.props.overviewXHeight - this.props.overviewXMargin.bottom})`}/>
                        <g ref={node => this.overviewXBrushSelection = select(node)}
                           transform={`translate(${this.props.margin.left}, ${this.props.overviewXMargin.top})`}
                           className={styles.brush}/>
                    </svg>}
                </div>
            );
        }
    }
}
