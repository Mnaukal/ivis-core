'use strict';

import React, {Component} from "react";
import * as d3Scale from "d3-scale";
import * as d3Selection from "d3-selection";
import * as d3Array from "d3-array";
import * as d3Scheme from "d3-scale-chromatic";
import {select} from "d3-selection";
import PropTypes from "prop-types";
import {withErrorHandling} from "../lib/error-handling";
import {withComponentMixins} from "../lib/decorator-helpers";
import {withTranslation} from "../lib/i18n";
import {PropType_d3Color, PropType_d3Color_Required, PropType_NumberInRange} from "../lib/CustomPropTypes";
import {Tooltip} from "./Tooltip";
import {extentWithMargin, RenderStatus} from "./common";
import {XZoomableChartBase} from "./XZoomableChartBase";

class TooltipContent extends Component {
    constructor(props) {
        super(props);
    }

    static propTypes = {
        config: PropTypes.object.isRequired,
        selection: PropTypes.object,
    };

    render() {
        if (this.props.selection) {
            return (
                <div>{this.props.selection.label}: {this.props.selection.value}</div>
            );

        } else {
            return null;
        }
    }
}

@withComponentMixins([
    withTranslation,
    withErrorHandling,
])
export class StaticBarChart extends Component {
    constructor(props){
        super(props);

        const t = props.t;

        this.state = {
            statusMsg: t('Loading...'),
        };

        this.xExtent = [0, 0];
        this.yExtent = [0, 0];
    }

    static propTypes = {
        config: PropTypes.shape({
            bars: PropTypes.arrayOf(PropTypes.shape({
                label: PropTypes.string.isRequired,
                color: PropType_d3Color(),
                value: PropTypes.number.isRequired
            })).isRequired
        }).isRequired,
        height: PropTypes.number.isRequired,
        margin: PropTypes.object,
        padding: PropType_NumberInRange(0, 1),
        colors: PropTypes.arrayOf(PropType_d3Color_Required()),

        minValue: PropTypes.number,
        maxValue: PropTypes.number,

        withTooltip: PropTypes.bool,
        withTransition: PropTypes.bool,
        withZoom: PropTypes.bool,

        zoomLevelMin: PropTypes.number,
        zoomLevelMax: PropTypes.number,

        className: PropTypes.string,
        style: PropTypes.object
    };

    static defaultProps = {
        margin: { left: 40, right: 5, top: 5, bottom: 20 },
        padding: 0.2,
        minValue: 0,
        colors: d3Scheme.schemeCategory10,

        withTooltip: true,
        withTransition: true,
        withZoom: true,

        zoomLevelMin: 1,
        zoomLevelMax: 4,
    };

    componentDidMount() {
        this.base.createChart(false, false);
    }

    /** Update and redraw the chart based on changes in React props and state */
    componentDidUpdate(prevProps, prevState) {
        const forceRefresh = !Object.is(prevProps.config, this.props.config);
        this.base.createChart(forceRefresh, false);
    }

    getXScale(range) {
        return d3Scale.scaleBand()
            .domain(this.xExtent)
            .range(range)
            .padding(this.props.padding);
    }

    getYScale(range) {
        return d3Scale.scaleLinear()
            .domain(this.yExtent)
            .range(range);
    }

    /** Computes the yExtent of the data. */
    prepareChart(base, forceRefresh, updateZoom, xScale, xSize, ySize) {
        if (!(forceRefresh || updateZoom) || this.props.config.bars.length === 0)
            return;

        let yExtent = extentWithMargin(d3Array.extent(this.props.config.bars, b => b.value), 0.1);
        if (this.props.minValue !== undefined)
            yExtent[0] = this.props.minValue;
        if (this.props.maxValue !== undefined)
            yExtent[1] = this.props.maxValue;
        this.yExtent = yExtent;
    }

    /** Creates (or updates) the chart with current data.
     * This method is called from the XZoomableChartBase base class (from createChart method, which is called from this.componentDidUpdate) */
    createChart(base, forceRefresh, updateZoom, xScale, yScale, xSize, ySize) {
        if (!forceRefresh && !updateZoom)
            return RenderStatus.SUCCESS;

        if (this.props.config.bars.length === 0)
            return RenderStatus.NO_DATA;

        this.xExtent = this.props.config.bars.map(b => b.label);

        this.drawVerticalBars(this.props.config.bars, this.barsSelection, xScale, yScale);

        return RenderStatus.SUCCESS;
    }

    // noinspection JSCommentMatchesSignature
    /** Draws the bars and also assigns them mouseover event handler to select them
     * @param data          data in format of props.config.bars
     * @param barsSelection d3 selection to which the data will get assigned and drawn
     */
    drawVerticalBars(data, barsSelection, xScale, yScale) {
        const self = this;
        const bars = barsSelection
            .selectAll('rect')
            .data(data, d => d.label);
        const ySize = yScale.range()[0];
        const barWidth = xScale.bandwidth();

        const selectBar = function(bar = null) {
            if (bar !== self.state.selection) {
                self.highlightSelection
                    .selectAll('rect')
                    .remove();

                if (bar !== null) {
                    self.highlightSelection
                        .append('rect')
                        .attr('x', xScale(bar.label))
                        .attr('y', yScale(bar.value))
                        .attr("width", barWidth)
                        .attr("height", ySize - yScale(bar.value))
                        .attr("fill", "none")
                        .attr("stroke", "black")
                        .attr("stroke-width", "2px");
                }
            }

            const containerPos = d3Selection.mouse(self.barsSelection.node());
            const mousePosition = {x: containerPos[0], y: containerPos[1]};

            self.setState({
                selection: bar,
                mousePosition
            });
        };

        const allBars = bars.enter()
            .append('rect')
            .attr('y', ySize)
            .attr("height", 0)
            .merge(bars)
            .attr('x', d => xScale(d.label))
            .attr("width", barWidth)
            .attr("fill", (d, i) => d.color || this.getColor(i))
            .on("mouseover", selectBar)
            .on("mousemove", selectBar)
            .on("mouseout", ::this.deselectBars);
        (this.props.withTransition ?  allBars.transition() : allBars)
            .attr('y', d => yScale(d.value))
            .attr("height", d => ySize - yScale(d.value));

        bars.exit()
            .remove();
    }

    getColor(i) {
        return this.props.colors[i % this.props.colors.length];
    }

    deselectBars() {
        this.highlightSelection
            .selectAll('rect')
            .remove();

        this.setState({
            selection: null,
            mousePosition: null
        });
    };

    getGraphContent(base, xScale, yScale, xSize, ySize) {
        return (<>
            <g ref={node => this.barsSelection = select(node)} />
            {!base.state.zoomInProgress &&
            <g ref={node => this.highlightSelection = select(node)}/>}

            {this.props.withTooltip && !base.state.zoomInProgress &&
            <Tooltip
                config={this.props.config}
                signalSetsData={this.props.config}
                containerHeight={ySize}
                containerWidth={xSize}
                mousePosition={this.state.mousePosition}
                selection={this.state.selection}
                contentRender={props => <TooltipContent {...props}/>}
                width={250}
            />}
        </>);
    }

    render() {
        return (
            <XZoomableChartBase
                ref={node => this.base = node}

                height={this.props.height}
                margin={this.props.margin}
                withOverview={false}
                withTransition={this.props.withTransition}
                withZoom={this.props.withZoom}

                getXScale={::this.getXScale}
                getYScale={::this.getYScale}

                createChart={::this.createChart}
                prepareChart={::this.prepareChart}
                getGraphContent={::this.getGraphContent}
                onZoomEnd={::this.deselectBars}

                zoomLevelMin={this.props.zoomLevelMin}
                zoomLevelMax={this.props.zoomLevelMax}
                className={this.props.className}
                style={this.props.style}
            />
        );
    }
}
