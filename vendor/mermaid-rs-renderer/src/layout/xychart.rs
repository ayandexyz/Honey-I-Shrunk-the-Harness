use super::*;

/// Number of decimals needed so that `step`-spaced tick labels stay distinct.
fn tick_decimals(step: f32) -> usize {
    let step = step.abs();
    if step == 0.0 {
        return 0;
    }
    let mut decimals = 0usize;
    while decimals < 6 {
        let scale = 10f32.powi(decimals as i32);
        if ((step * scale).round() / scale - step).abs() <= step * 1e-3 {
            break;
        }
        decimals += 1;
    }
    decimals
}

pub(super) fn compute_xychart_layout(
    graph: &Graph,
    theme: &Theme,
    config: &LayoutConfig,
) -> Layout {
    let data = &graph.xychart;
    let padding = 40.0;
    let y_axis_width = 60.0;
    let category_blocks: Vec<_> = data
        .x_axis_categories
        .iter()
        .map(|category| measure_label(category, theme, config))
        .collect();
    let x_axis_label = data
        .x_axis_label
        .as_ref()
        .map(|label| measure_label(label, theme, config));
    let category_height = category_blocks
        .iter()
        .map(|block| block.height)
        .fold(0.0_f32, f32::max);
    let x_axis_height = (category_height
        + 16.0
        + x_axis_label
            .as_ref()
            .map(|label| label.height + 10.0)
            .unwrap_or(0.0))
    .max(40.0);
    let title = data.title.as_ref().map(|t| measure_label(t, theme, config));
    // Size the title band from the measured (possibly wrapped) title so long
    // titles do not overlap the plot area.
    let title_height = title
        .as_ref()
        .map(|t| (t.height + 12.0).max(30.0))
        .unwrap_or(0.0);

    let measured_category_width = category_blocks
        .windows(2)
        .map(|pair| pair[0].width / 2.0 + pair[1].width / 2.0 + 12.0)
        .fold(0.0_f32, f32::max);
    let plot_width = 400.0_f32.max(measured_category_width * category_blocks.len().max(1) as f32);
    let plot_height = 250.0;

    let width = padding * 2.0 + y_axis_width + plot_width;
    let height = padding * 2.0 + title_height + plot_height + x_axis_height;

    let plot_x = padding + y_axis_width;
    let plot_y = padding + title_height;

    // Find min/max values
    let all_values: Vec<f32> = data
        .series
        .iter()
        .flat_map(|s| s.values.iter().copied().filter(|v| v.is_finite()))
        .collect();
    let min_val = data
        .y_axis_min
        .filter(|v| v.is_finite())
        .unwrap_or_else(|| all_values.iter().copied().fold(0.0_f32, f32::min).min(0.0));
    let max_val = data
        .y_axis_max
        .filter(|v| v.is_finite())
        .unwrap_or_else(|| all_values.iter().copied().fold(0.0_f32, f32::max));
    // Guard only against degenerate (zero/near-zero) ranges; sub-1 explicit
    // ranges like `y-axis 0 --> 0.5` must keep their true span.
    let raw_range = max_val - min_val;
    let range = if raw_range.abs() < 1e-6 {
        1.0
    } else {
        raw_range
    };

    // Number of categories
    let num_categories = data
        .x_axis_categories
        .len()
        .max(
            data.series
                .iter()
                .map(|s| s.values.len())
                .max()
                .unwrap_or(0),
        )
        .max(1);

    let bar_group_width = plot_width / num_categories as f32;
    let bar_padding = bar_group_width * 0.1;

    // Count bar series for width calculation
    let bar_count = data
        .series
        .iter()
        .filter(|s| s.kind == crate::ir::XYSeriesKind::Bar)
        .count()
        .max(1);
    let bar_width = (bar_group_width - bar_padding * 2.0) / bar_count as f32;

    let colors = [
        "#4e79a7".to_string(),
        "#f28e2c".to_string(),
        "#e15759".to_string(),
        "#76b7b2".to_string(),
        "#59a14f".to_string(),
        "#edc949".to_string(),
        "#af7aa1".to_string(),
        "#ff9da7".to_string(),
    ];

    let mut bars = Vec::new();
    let mut lines = Vec::new();
    let mut bar_series_idx = 0;

    for (series_idx, series) in data.series.iter().enumerate() {
        let color = colors
            .get(series_idx % colors.len())
            .cloned()
            .unwrap_or_else(|| "#333".to_string());

        match series.kind {
            crate::ir::XYSeriesKind::Bar => {
                for (i, value) in series.values.iter().copied().enumerate() {
                    if !value.is_finite() {
                        // Skip NaN/Infinity instead of fabricating a bar at 0.
                        continue;
                    }
                    // Keep bars at (or below) the axis minimum visible, like
                    // mermaid-js which enforces a minimum bar height.
                    let bar_height = (((value - min_val) / range) * plot_height).max(2.0);
                    let x = plot_x
                        + i as f32 * bar_group_width
                        + bar_padding
                        + bar_series_idx as f32 * bar_width;
                    let y = plot_y + plot_height - bar_height;

                    bars.push(XYChartBarLayout {
                        x,
                        y,
                        width: bar_width,
                        height: bar_height,
                        value,
                        color: color.clone(),
                    });
                }
                bar_series_idx += 1;
            }
            crate::ir::XYSeriesKind::Line => {
                let points: Vec<(f32, f32)> = series
                    .values
                    .iter()
                    .copied()
                    .enumerate()
                    .filter(|(_, value)| value.is_finite())
                    .map(|(i, value)| {
                        let x = plot_x + i as f32 * bar_group_width + bar_group_width / 2.0;
                        let y = plot_y + plot_height - ((value - min_val) / range) * plot_height;
                        (x, y)
                    })
                    .collect();

                lines.push(XYChartLineLayout { points, color });
            }
        }
    }

    // X-axis categories
    let x_axis_categories: Vec<(String, f32)> = data
        .x_axis_categories
        .iter()
        .enumerate()
        .map(|(i, cat)| {
            let x = plot_x + i as f32 * bar_group_width + bar_group_width / 2.0;
            (cat.clone(), x)
        })
        .collect();

    // Y-axis ticks
    let num_ticks = 5;
    let tick_step = range / num_ticks as f32;
    let decimals = tick_decimals(tick_step);
    let y_axis_ticks: Vec<(String, f32)> = (0..=num_ticks)
        .map(|i| {
            let value = min_val + (i as f32 / num_ticks as f32) * range;
            let y = plot_y + plot_height - (i as f32 / num_ticks as f32) * plot_height;
            (format!("{:.*}", decimals, value), y)
        })
        .collect();

    let y_axis_label = data
        .y_axis_label
        .as_ref()
        .map(|l| measure_label(l, theme, config));

    Layout {
        kind: graph.kind,
        nodes: BTreeMap::new(),
        edges: Vec::new(),
        subgraphs: Vec::new(),
        diagram: DiagramData::XYChart(XYChartLayout {
            title,
            title_y: padding + title_height / 2.0,
            x_axis_label,
            x_axis_label_y: plot_y + plot_height + x_axis_height - 10.0,
            y_axis_label,
            y_axis_label_x: padding,
            x_axis_categories,
            y_axis_ticks,
            bars,
            lines,
            plot_x,
            plot_y,
            plot_width,
            plot_height,
            width,
            height,
        }),
        width,
        height,
    }
}
