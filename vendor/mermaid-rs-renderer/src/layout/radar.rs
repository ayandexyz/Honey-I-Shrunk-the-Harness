use std::collections::BTreeMap;
use std::f32::consts::PI;

use crate::config::LayoutConfig;
use crate::ir::{Graph, RadarData, RadarEntry};
use crate::theme::Theme;

use super::text::{measure_label, measure_label_with_font_size};
use super::{DiagramData, Layout, RadarSeriesLayout};

// Single source of truth for radar geometry. `render_radar` in src/render.rs
// draws with these same constants so layout bounds and rendered geometry can
// never disagree.
pub(crate) const MAX_RADIUS: f32 = 300.0;
pub(crate) const DEFAULT_TICKS: usize = 5;
pub(crate) const AXIS_LABEL_OFFSET: f32 = 15.0;
pub(crate) const AXIS_LABEL_NUDGE: f32 = 6.0;
pub(crate) const AXIS_LABEL_FONT_SIZE: f32 = 12.0;
pub(crate) const LEGEND_BOX_SIZE: f32 = 12.0;
pub(crate) const LEGEND_GAP: f32 = 4.0;
pub(crate) const LEGEND_OFFSET_FACTOR: f32 = 0.8;
/// Minimum half-extent of the canvas around the chart center. Keeps the
/// historical 700x700 canvas when labels are short.
pub(crate) const MIN_HALF_EXTENT: f32 = MAX_RADIUS + 50.0;
/// Clearance between outermost label geometry and the canvas edge.
const CANVAS_MARGIN: f32 = 10.0;

pub(crate) fn legend_row_height(font_size: f32) -> f32 {
    font_size + 6.0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AxisAnchor {
    Start,
    Middle,
    End,
}

impl AxisAnchor {
    pub(crate) fn as_svg(self) -> &'static str {
        match self {
            AxisAnchor::Start => "start",
            AxisAnchor::Middle => "middle",
            AxisAnchor::End => "end",
        }
    }
}

/// Angle of axis `idx` out of `axis_count`, starting at 12 o'clock and going
/// clockwise (SVG y grows downward).
pub(crate) fn axis_angle(idx: usize, axis_count: usize) -> f32 {
    -PI / 2.0 + 2.0 * PI * idx as f32 / axis_count.max(1) as f32
}

/// Position and anchoring of an axis label, relative to the chart center.
/// Labels on the right anchor at their start and labels on the left anchor at
/// their end so the text always extends outward, away from the grid circle.
pub(crate) fn axis_label_position(angle: f32) -> (f32, f32, AxisAnchor) {
    let label_r = MAX_RADIUS + AXIS_LABEL_OFFSET;
    let mut lx = label_r * angle.cos();
    let ly = label_r * angle.sin();
    let anchor = if angle.cos() > 0.35 {
        lx += AXIS_LABEL_NUDGE;
        AxisAnchor::Start
    } else if angle.cos() < -0.35 {
        lx -= AXIS_LABEL_NUDGE;
        AxisAnchor::End
    } else {
        AxisAnchor::Middle
    };
    (lx, ly, anchor)
}

/// Horizontal bbox of an axis label of width `w` placed by
/// [`axis_label_position`]. Returns (x0, x1) relative to the chart center.
pub(crate) fn axis_label_x_extent(lx: f32, anchor: AxisAnchor, w: f32) -> (f32, f32) {
    match anchor {
        AxisAnchor::Start => (lx, lx + w),
        AxisAnchor::End => (lx - w, lx),
        AxisAnchor::Middle => (lx - w / 2.0, lx + w / 2.0),
    }
}

/// Measured width of an axis label at the radar axis font size. Shared by the
/// layout bounds computation and geometry tests.
pub(crate) fn axis_label_width(axis: &str, theme: &Theme, config: &LayoutConfig) -> f32 {
    measure_label_with_font_size(
        axis,
        AXIS_LABEL_FONT_SIZE,
        config,
        false,
        theme.font_family.as_str(),
    )
    .width
}

/// Effective axis list for a radar chart.
///
/// Declared axes are authoritative: every curve binds to them regardless of
/// where (or whether) the `axis` line appeared relative to the `curve` lines.
/// When no axis was declared at all, axes are synthesized so curves still
/// render: named entries contribute their names in first-appearance order,
/// then unlabeled axes pad up to the longest positional curve.
fn effective_axes(radar: &RadarData) -> Vec<String> {
    if !radar.axes.is_empty() {
        return radar.axes.clone();
    }
    let mut axes: Vec<String> = Vec::new();
    let mut max_positional = 0usize;
    for curve in &radar.curves {
        max_positional = max_positional.max(curve.entries.len());
        for entry in &curve.entries {
            if let RadarEntry::Named(name, _) = entry
                && !axes.iter().any(|axis| axis == name)
            {
                axes.push(name.clone());
            }
        }
    }
    while axes.len() < max_positional {
        axes.push(String::new());
    }
    axes
}

/// Resolves curves against the axis list into per-axis value rows, clamped to
/// `[min_value, max_value]`.
///
/// Positional entries bind by index; entries beyond the axis count are
/// truncated. Named entries bind by axis name (unknown names are ignored,
/// matching upstream, which never looks up extras). Missing, empty, and
/// non-numeric values fall back to `min_value` (the chart center) without
/// shifting later positional values, because the parser preserves their slots.
struct ResolvedRadar {
    axes: Vec<String>,
    series: Vec<RadarSeriesLayout>,
    min_value: f32,
    max_value: f32,
    ticks: usize,
}

fn resolve_radar(radar: &RadarData) -> ResolvedRadar {
    let axes = effective_axes(radar);

    let min_value = radar.min.filter(|value| value.is_finite()).unwrap_or(0.0);
    let mut data_max = f32::NEG_INFINITY;

    let mut series = Vec::with_capacity(radar.curves.len());
    for curve in &radar.curves {
        let mut values: Vec<Option<f32>> = vec![None; axes.len()];
        for (idx, entry) in curve.entries.iter().enumerate() {
            match entry {
                RadarEntry::Positional(value) => {
                    if let Some(slot) = values.get_mut(idx) {
                        *slot = value.filter(|value| value.is_finite());
                    }
                }
                RadarEntry::Named(name, value) => {
                    if let Some(pos) = axes.iter().position(|axis| axis == name)
                        && let Some(slot) = values.get_mut(pos)
                    {
                        *slot = value.filter(|value| value.is_finite());
                    }
                }
            }
        }
        for value in values.iter().flatten() {
            data_max = data_max.max(*value);
        }
        series.push((curve.name.clone(), values));
    }

    let max_value = radar
        .max
        .filter(|value| value.is_finite())
        .unwrap_or(if data_max.is_finite() { data_max } else { 0.0 });
    // Degenerate or inverted scales (all values at/below min, or an explicit
    // max <= min) collapse to a unit span so radii stay finite.
    let max_value = if max_value > min_value {
        max_value
    } else {
        min_value + 1.0
    };

    let series = series
        .into_iter()
        .map(|(name, values)| RadarSeriesLayout {
            name,
            values: values
                .into_iter()
                .map(|value| value.unwrap_or(min_value).clamp(min_value, max_value))
                .collect(),
        })
        .collect();

    ResolvedRadar {
        axes,
        series,
        min_value,
        max_value,
        ticks: radar.ticks.unwrap_or(DEFAULT_TICKS).max(1),
    }
}

pub(super) fn compute_radar_layout(graph: &Graph, theme: &Theme, config: &LayoutConfig) -> Layout {
    let resolved = resolve_radar(&graph.radar);
    let legend_offset = MAX_RADIUS * LEGEND_OFFSET_FACTOR;
    let row_height = legend_row_height(theme.font_size);

    // Canvas half-extents around the chart center, grown by measured axis
    // label, legend, and title geometry so nothing clips at the canvas edge.
    let mut left = MIN_HALF_EXTENT;
    let mut right = MIN_HALF_EXTENT;
    let mut top = MIN_HALF_EXTENT;
    let mut bottom = MIN_HALF_EXTENT;

    for (idx, axis) in resolved.axes.iter().enumerate() {
        if axis.is_empty() {
            continue;
        }
        let angle = axis_angle(idx, resolved.axes.len());
        let (lx, ly, anchor) = axis_label_position(angle);
        let label_width = axis_label_width(axis, theme, config);
        let (x0, x1) = axis_label_x_extent(lx, anchor, label_width);
        let half_h = AXIS_LABEL_FONT_SIZE / 2.0;
        left = left.max(-x0 + CANVAS_MARGIN);
        right = right.max(x1 + CANVAS_MARGIN);
        top = top.max(-(ly - half_h) + CANVAS_MARGIN);
        bottom = bottom.max(ly + half_h + CANVAS_MARGIN);
    }

    let mut legend_blocks = Vec::with_capacity(resolved.series.len());
    for (idx, series) in resolved.series.iter().enumerate() {
        let label = measure_label(&series.name, theme, config);
        let row_y = -legend_offset + idx as f32 * row_height;
        right =
            right.max(legend_offset + LEGEND_BOX_SIZE + LEGEND_GAP + label.width + CANVAS_MARGIN);
        bottom = bottom.max(row_y + label.height.max(LEGEND_BOX_SIZE) + CANVAS_MARGIN);
        legend_blocks.push(label);
    }

    if let Some(title) = graph.radar.title.as_deref() {
        let block = measure_label(title, theme, config);
        left = left.max(block.width / 2.0 + CANVAS_MARGIN);
        right = right.max(block.width / 2.0 + CANVAS_MARGIN);
        // The renderer hangs the title from MAX_RADIUS + 50 above the center.
        // Reserve its full measured multiline height above the chart.
        top = top.max(MAX_RADIUS + 50.0 + block.height + CANVAS_MARGIN);
    }

    let center_x = left;
    let center_y = top;

    // Legend rows as NodeLayouts: kept purely as geometry (bounds metrics,
    // invariants, layout dumps). The renderer draws legends from the
    // structural series list, never from these nodes.
    let mut nodes = BTreeMap::new();
    for (idx, label) in legend_blocks.into_iter().enumerate() {
        let width = LEGEND_BOX_SIZE + LEGEND_GAP + label.width;
        let height = label.height.max(LEGEND_BOX_SIZE);
        let mut style = crate::ir::NodeStyle::default();
        style.stroke = Some("none".to_string());
        style.stroke_width = Some(0.0);
        let id = format!("radar_{idx}");
        nodes.insert(
            id.clone(),
            crate::layout::NodeLayout {
                id,
                x: center_x + legend_offset,
                y: center_y - legend_offset + idx as f32 * row_height,
                width,
                height,
                label,
                shape: crate::ir::NodeShape::Circle,
                style,
                link: None,
                anchor_subgraph: None,
                hidden: false,
                icon: None,
            },
        );
    }

    Layout {
        kind: graph.kind,
        nodes,
        edges: Vec::new(),
        subgraphs: Vec::new(),
        width: left + right,
        height: top + bottom,
        diagram: DiagramData::Radar(super::RadarLayout {
            title: graph.radar.title.clone(),
            center_x,
            center_y,
            axes: resolved.axes,
            series: resolved.series,
            min_value: resolved.min_value,
            max_value: resolved.max_value,
            ticks: resolved.ticks,
            graticule: graph.radar.graticule,
        }),
    }
}
