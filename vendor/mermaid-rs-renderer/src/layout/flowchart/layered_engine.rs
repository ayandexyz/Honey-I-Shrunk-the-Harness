use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::config::FlowchartLayoutEngine;
use crate::ir::{Direction, Edge};

use super::super::NodeLayout;
use super::manual_layout::ManualLayoutRanks;

/// Deterministic snapshot of the layered node-placement boundary.
///
/// This is captured immediately after rank assignment, within-rank ordering,
/// and coordinate assignment, before aspect folding, subgraph cleanup, routing,
/// label placement, or rendering can alter the geometry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayeredLayoutSnapshot {
    pub engine: String,
    pub selected_engine: String,
    pub direction: String,
    pub ranks: Vec<LayeredRankSnapshot>,
    pub nodes: Vec<LayeredNodeSnapshot>,
    pub edges: Vec<LayeredEdgeSnapshot>,
    pub feedback_edges: Vec<LayeredFeedbackEdgeSnapshot>,
    pub metrics: LayeredLayoutMetrics,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayeredRankSnapshot {
    pub index: usize,
    pub nodes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayeredNodeSnapshot {
    pub id: String,
    pub rank: usize,
    pub order: usize,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayeredEdgeSnapshot {
    pub from: String,
    pub to: String,
    pub from_rank: usize,
    pub to_rank: usize,
    pub rank_span: usize,
    pub feedback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayeredFeedbackEdgeSnapshot {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayeredLayoutMetrics {
    pub node_overlaps: usize,
    pub adjacent_rank_crossings: usize,
    pub straight_line_crossings: usize,
    pub feedback_edges: usize,
    pub total_rank_span: usize,
    pub centerline_manhattan: f32,
    pub layout_area: f32,
}

impl LayeredLayoutSnapshot {
    pub(in crate::layout) fn from_stage(
        requested_engine: FlowchartLayoutEngine,
        selected_engine: FlowchartLayoutEngine,
        direction: Direction,
        nodes: &BTreeMap<String, NodeLayout>,
        edges: &[Edge],
        ranks: &ManualLayoutRanks,
    ) -> Self {
        let mut position_by_id: HashMap<&str, (usize, usize)> = HashMap::new();
        let rank_snapshots = ranks
            .rank_nodes
            .iter()
            .enumerate()
            .map(|(rank, bucket)| {
                for (order, id) in bucket.iter().enumerate() {
                    position_by_id.insert(id.as_str(), (rank, order));
                }
                LayeredRankSnapshot {
                    index: rank,
                    nodes: bucket.clone(),
                }
            })
            .collect::<Vec<_>>();

        let node_snapshots = nodes
            .values()
            .filter_map(|node| {
                let (rank, order) = position_by_id.get(node.id.as_str()).copied()?;
                Some(LayeredNodeSnapshot {
                    id: node.id.clone(),
                    rank,
                    order,
                    x: node.x,
                    y: node.y,
                    width: node.width,
                    height: node.height,
                    hidden: node.hidden,
                })
            })
            .collect::<Vec<_>>();

        let feedback_set = ranks
            .feedback_edges
            .iter()
            .map(|(from, to)| (from.as_str(), to.as_str()))
            .collect::<HashSet<_>>();
        let edge_snapshots = edges
            .iter()
            .filter_map(|edge| {
                let (from_rank, _) = position_by_id.get(edge.from.as_str()).copied()?;
                let (to_rank, _) = position_by_id.get(edge.to.as_str()).copied()?;
                let feedback = feedback_set.contains(&(edge.from.as_str(), edge.to.as_str()))
                    || to_rank <= from_rank;
                Some(LayeredEdgeSnapshot {
                    from: edge.from.clone(),
                    to: edge.to.clone(),
                    from_rank,
                    to_rank,
                    rank_span: from_rank.abs_diff(to_rank),
                    feedback,
                })
            })
            .collect::<Vec<_>>();

        let mut feedback_edges = edge_snapshots
            .iter()
            .filter(|edge| edge.feedback)
            .map(|edge| LayeredFeedbackEdgeSnapshot {
                from: edge.from.clone(),
                to: edge.to.clone(),
            })
            .collect::<Vec<_>>();
        feedback_edges.sort_by(|a, b| (&a.from, &a.to).cmp(&(&b.from, &b.to)));
        feedback_edges.dedup();

        let metrics = compute_metrics(&node_snapshots, &edge_snapshots);
        Self {
            engine: requested_engine.as_str().to_string(),
            selected_engine: selected_engine.as_str().to_string(),
            direction: direction_name(direction).to_string(),
            ranks: rank_snapshots,
            nodes: node_snapshots,
            edges: edge_snapshots,
            feedback_edges,
            metrics,
        }
    }
}

/// Accept a candidate only when it is Pareto-safe on hard/strict placement
/// metrics and produces a declared improvement. Large size detours remain
/// bounded even when crossings or feedback arcs improve.
pub(in crate::layout) fn candidate_preferred(
    current: &LayeredLayoutSnapshot,
    candidate: &LayeredLayoutSnapshot,
) -> bool {
    let a = &current.metrics;
    let b = &candidate.metrics;
    if b.node_overlaps > a.node_overlaps
        || b.adjacent_rank_crossings > a.adjacent_rank_crossings
        || b.straight_line_crossings > a.straight_line_crossings
        || b.feedback_edges > a.feedback_edges
    {
        return false;
    }
    if b.adjacent_rank_crossings < a.adjacent_rank_crossings {
        return b.layout_area <= a.layout_area.max(1.0) * 1.25
            && b.centerline_manhattan <= a.centerline_manhattan.max(1.0) * 1.25;
    }
    if b.straight_line_crossings < a.straight_line_crossings {
        return b.layout_area <= a.layout_area.max(1.0) * 1.02
            && b.centerline_manhattan <= a.centerline_manhattan.max(1.0) * 1.02;
    }
    if b.feedback_edges < a.feedback_edges {
        return b.layout_area <= a.layout_area.max(1.0) * 1.02
            && b.centerline_manhattan <= a.centerline_manhattan;
    }
    if b.total_rank_span < a.total_rank_span {
        return b.layout_area <= a.layout_area.max(1.0) * 1.05
            && b.centerline_manhattan <= a.centerline_manhattan.max(1.0) * 1.05;
    }
    b.centerline_manhattan <= a.centerline_manhattan * 0.99
        && b.layout_area <= a.layout_area.max(1.0) * 1.02
}

fn compute_metrics(
    nodes: &[LayeredNodeSnapshot],
    edges: &[LayeredEdgeSnapshot],
) -> LayeredLayoutMetrics {
    let visible = nodes.iter().filter(|node| !node.hidden).collect::<Vec<_>>();
    let mut node_overlaps = 0usize;
    for i in 0..visible.len() {
        for j in (i + 1)..visible.len() {
            let a = visible[i];
            let b = visible[j];
            let overlap_x = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
            let overlap_y = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
            if overlap_x > 1e-3 && overlap_y > 1e-3 {
                node_overlaps += 1;
            }
        }
    }
    let order_by_id = nodes
        .iter()
        .map(|node| (node.id.as_str(), (node.rank, node.order)))
        .collect::<HashMap<_, _>>();
    let mut by_gap: HashMap<usize, Vec<(&str, &str, usize, usize)>> = HashMap::new();
    for edge in edges {
        if edge.to_rank != edge.from_rank + 1 {
            continue;
        }
        let Some(&(from_rank, from_order)) = order_by_id.get(edge.from.as_str()) else {
            continue;
        };
        let Some(&(_, to_order)) = order_by_id.get(edge.to.as_str()) else {
            continue;
        };
        by_gap.entry(from_rank).or_default().push((
            edge.from.as_str(),
            edge.to.as_str(),
            from_order,
            to_order,
        ));
    }
    let mut adjacent_rank_crossings = 0usize;
    for gap_edges in by_gap.values() {
        for i in 0..gap_edges.len() {
            for j in (i + 1)..gap_edges.len() {
                let (a_from, a_to, a0, a1) = gap_edges[i];
                let (b_from, b_to, b0, b1) = gap_edges[j];
                if a_from == b_from || a_to == b_to {
                    continue;
                }
                if (a0 < b0 && a1 > b1) || (a0 > b0 && a1 < b1) {
                    adjacent_rank_crossings += 1;
                }
            }
        }
    }
    let centers = visible
        .iter()
        .map(|node| {
            (
                node.id.as_str(),
                (node.x + node.width / 2.0, node.y + node.height / 2.0),
            )
        })
        .collect::<HashMap<_, _>>();
    let centerline_manhattan = edges
        .iter()
        .filter_map(|edge| {
            Some((
                centers.get(edge.from.as_str())?,
                centers.get(edge.to.as_str())?,
            ))
        })
        .map(|(from, to)| (to.0 - from.0).abs() + (to.1 - from.1).abs())
        .sum();
    let center_segments = edges
        .iter()
        .filter_map(|edge| {
            Some((
                edge.from.as_str(),
                edge.to.as_str(),
                *centers.get(edge.from.as_str())?,
                *centers.get(edge.to.as_str())?,
            ))
        })
        .collect::<Vec<_>>();
    let mut straight_line_crossings = 0usize;
    for i in 0..center_segments.len() {
        for j in (i + 1)..center_segments.len() {
            let (a_from, a_to, a0, a1) = center_segments[i];
            let (b_from, b_to, b0, b1) = center_segments[j];
            if a_from == b_from || a_from == b_to || a_to == b_from || a_to == b_to {
                continue;
            }
            if proper_segment_crossing(a0, a1, b0, b1) {
                straight_line_crossings += 1;
            }
        }
    }
    let layout_area = if visible.is_empty() {
        0.0
    } else {
        let min_x = visible
            .iter()
            .map(|node| node.x)
            .fold(f32::INFINITY, f32::min);
        let min_y = visible
            .iter()
            .map(|node| node.y)
            .fold(f32::INFINITY, f32::min);
        let max_x = visible
            .iter()
            .map(|node| node.x + node.width)
            .fold(f32::NEG_INFINITY, f32::max);
        let max_y = visible
            .iter()
            .map(|node| node.y + node.height)
            .fold(f32::NEG_INFINITY, f32::max);
        (max_x - min_x).max(0.0) * (max_y - min_y).max(0.0)
    };
    LayeredLayoutMetrics {
        node_overlaps,
        adjacent_rank_crossings,
        straight_line_crossings,
        feedback_edges: edges.iter().filter(|edge| edge.feedback).count(),
        total_rank_span: edges.iter().map(|edge| edge.rank_span).sum(),
        centerline_manhattan,
        layout_area,
    }
}

fn proper_segment_crossing(a: (f32, f32), b: (f32, f32), c: (f32, f32), d: (f32, f32)) -> bool {
    fn orient(a: (f32, f32), b: (f32, f32), c: (f32, f32)) -> f32 {
        (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
    }
    let ab_c = orient(a, b, c);
    let ab_d = orient(a, b, d);
    let cd_a = orient(c, d, a);
    let cd_b = orient(c, d, b);
    (ab_c > 1e-3 && ab_d < -1e-3 || ab_c < -1e-3 && ab_d > 1e-3)
        && (cd_a > 1e-3 && cd_b < -1e-3 || cd_a < -1e-3 && cd_b > 1e-3)
}

fn direction_name(direction: Direction) -> &'static str {
    match direction {
        Direction::TopDown => "TD",
        Direction::BottomTop => "BT",
        Direction::LeftRight => "LR",
        Direction::RightLeft => "RL",
    }
}

pub fn write_layered_layout_dump(
    path: &Path,
    snapshot: &LayeredLayoutSnapshot,
) -> anyhow::Result<()> {
    let file = File::create(path)?;
    let writer = BufWriter::new(file);
    serde_json::to_writer_pretty(writer, snapshot)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::NodeShape;
    use crate::layout::TextBlock;

    fn snapshot_with_metrics(metrics: LayeredLayoutMetrics) -> LayeredLayoutSnapshot {
        LayeredLayoutSnapshot {
            engine: "auto".into(),
            selected_engine: "dagre".into(),
            direction: "TD".into(),
            ranks: Vec::new(),
            nodes: Vec::new(),
            edges: Vec::new(),
            feedback_edges: Vec::new(),
            metrics,
        }
    }

    fn base_metrics() -> LayeredLayoutMetrics {
        LayeredLayoutMetrics {
            node_overlaps: 0,
            adjacent_rank_crossings: 3,
            straight_line_crossings: 8,
            feedback_edges: 2,
            total_rank_span: 20,
            centerline_manhattan: 1000.0,
            layout_area: 100_000.0,
        }
    }

    #[test]
    fn snapshot_is_ordered_by_rank_and_node_map() {
        let mut nodes = BTreeMap::new();
        for (id, x) in [("A", 0.0), ("B", 100.0)] {
            nodes.insert(
                id.to_string(),
                NodeLayout {
                    id: id.to_string(),
                    x,
                    y: 0.0,
                    width: 40.0,
                    height: 20.0,
                    label: TextBlock {
                        lines: vec![id.to_string()],
                        width: 10.0,
                        height: 10.0,
                    },
                    shape: NodeShape::Rectangle,
                    style: Default::default(),
                    link: None,
                    anchor_subgraph: None,
                    hidden: false,
                    icon: None,
                },
            );
        }
        let ranks = ManualLayoutRanks {
            rank_nodes: vec![vec!["A".into()], vec!["B".into()]],
            feedback_edges: Vec::new(),
        };
        let edges = Vec::new();
        let snapshot = LayeredLayoutSnapshot::from_stage(
            FlowchartLayoutEngine::Current,
            FlowchartLayoutEngine::Current,
            Direction::TopDown,
            &nodes,
            &edges,
            &ranks,
        );
        assert_eq!(snapshot.engine, "current");
        assert_eq!(snapshot.nodes[0].id, "A");
        assert_eq!(snapshot.nodes[1].rank, 1);
    }

    #[test]
    fn candidate_guard_rejects_crossing_proxy_regressions() {
        let current = snapshot_with_metrics(base_metrics());
        let mut candidate_metrics = base_metrics();
        candidate_metrics.adjacent_rank_crossings = 2;
        candidate_metrics.straight_line_crossings = 9;
        let candidate = snapshot_with_metrics(candidate_metrics);
        assert!(!candidate_preferred(&current, &candidate));
    }

    #[test]
    fn candidate_guard_accepts_bounded_centerline_improvement() {
        let current = snapshot_with_metrics(base_metrics());
        let mut candidate_metrics = base_metrics();
        candidate_metrics.centerline_manhattan = 980.0;
        let candidate = snapshot_with_metrics(candidate_metrics);
        assert!(candidate_preferred(&current, &candidate));
    }

    #[test]
    fn candidate_guard_rejects_unbounded_area_tradeoff() {
        let current = snapshot_with_metrics(base_metrics());
        let mut candidate_metrics = base_metrics();
        candidate_metrics.adjacent_rank_crossings = 2;
        candidate_metrics.layout_area = 125_001.0;
        let candidate = snapshot_with_metrics(candidate_metrics);
        assert!(!candidate_preferred(&current, &candidate));
    }

    #[test]
    fn candidate_guard_requires_a_material_relative_improvement() {
        let current = snapshot_with_metrics(base_metrics());
        let mut candidate_metrics = base_metrics();
        candidate_metrics.centerline_manhattan = 995.0;
        let candidate = snapshot_with_metrics(candidate_metrics);
        assert!(!candidate_preferred(&current, &candidate));
    }

    #[test]
    fn candidate_guard_rejects_feedback_win_with_longer_centerlines() {
        let current = snapshot_with_metrics(base_metrics());
        let mut candidate_metrics = base_metrics();
        candidate_metrics.feedback_edges = 1;
        candidate_metrics.centerline_manhattan = 1000.1;
        let candidate = snapshot_with_metrics(candidate_metrics);
        assert!(!candidate_preferred(&current, &candidate));
    }
}
