use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::config::LayoutConfig;
use crate::ir::Graph;
use crate::theme::Theme;

use super::text::measure_label;
use super::{
    DiagramData, EdgeLayout, Layout, NodeLayout, SankeyLayout, SankeyLinkLayout, SankeyNodeLayout,
    resolve_node_style,
};

pub(super) fn compute_sankey_layout(graph: &Graph, theme: &Theme, config: &LayoutConfig) -> Layout {
    const SANKEY_MIN_WIDTH: f32 = 560.0;
    const SANKEY_MAX_WIDTH: f32 = 640.0;
    const SANKEY_HEIGHT: f32 = 360.0;
    const SANKEY_NODE_WIDTH: f32 = 10.0;
    const SANKEY_NODE_GAP: f32 = 8.0;
    const SANKEY_PALETTE: [&str; 10] = [
        "#4e79a7", "#f28e2c", "#e15759", "#76b7b2", "#59a14f", "#edc949", "#af7aa1", "#ff9da7",
        "#9c755f", "#bab0ab",
    ];

    let mut node_ids: Vec<String> = graph.nodes.keys().cloned().collect();
    node_ids.sort_by(|a, b| {
        let order_a = graph.node_order.get(a).copied().unwrap_or(usize::MAX);
        let order_b = graph.node_order.get(b).copied().unwrap_or(usize::MAX);
        order_a.cmp(&order_b).then_with(|| a.cmp(b))
    });

    let node_count = node_ids.len();
    let mut id_to_idx: HashMap<String, usize> = HashMap::new();
    for (idx, id) in node_ids.iter().enumerate() {
        id_to_idx.insert(id.clone(), idx);
    }

    let node_order_idx: Vec<usize> = node_ids
        .iter()
        .map(|id| graph.node_order.get(id).copied().unwrap_or(usize::MAX))
        .collect();

    #[derive(Debug, Clone)]
    struct SankeyEdgeData {
        from_idx: usize,
        to_idx: usize,
        value: f32,
    }

    let mut edges_data: Vec<SankeyEdgeData> = Vec::new();
    let mut incoming: Vec<Vec<usize>> = vec![Vec::new(); node_count];
    let mut outgoing: Vec<Vec<usize>> = vec![Vec::new(); node_count];
    let mut in_total: Vec<f32> = vec![0.0; node_count];
    let mut out_total: Vec<f32> = vec![0.0; node_count];

    for edge in &graph.edges {
        let Some(&from_idx) = id_to_idx.get(&edge.from) else {
            continue;
        };
        let Some(&to_idx) = id_to_idx.get(&edge.to) else {
            continue;
        };
        let raw_value = edge
            .label
            .as_deref()
            .and_then(|text| text.parse::<f32>().ok())
            .unwrap_or(1.0);
        let value = if raw_value.is_finite() {
            raw_value.max(0.0)
        } else {
            0.0
        };
        let edge_idx = edges_data.len();
        edges_data.push(SankeyEdgeData {
            from_idx,
            to_idx,
            value,
        });
        outgoing[from_idx].push(edge_idx);
        incoming[to_idx].push(edge_idx);
        out_total[from_idx] += value;
        in_total[to_idx] += value;
    }

    // Condense strongly connected components into a DAG. Component ranks use
    // longest paths, just like ordinary acyclic Sankey ranking. A component
    // occupies one column per member so cycles remain visible without making
    // unrelated or disconnected nodes consume columns.
    fn visit(
        node: usize,
        outgoing: &[Vec<usize>],
        edges: &[SankeyEdgeData],
        seen: &mut [bool],
        finish: &mut Vec<usize>,
    ) {
        if seen[node] {
            return;
        }
        seen[node] = true;
        for &edge_idx in &outgoing[node] {
            visit(edges[edge_idx].to_idx, outgoing, edges, seen, finish);
        }
        finish.push(node);
    }

    fn assign_component(
        node: usize,
        incoming: &[Vec<usize>],
        edges: &[SankeyEdgeData],
        component: usize,
        component_of: &mut [usize],
        members: &mut Vec<usize>,
    ) {
        if component_of[node] != usize::MAX {
            return;
        }
        component_of[node] = component;
        members.push(node);
        for &edge_idx in &incoming[node] {
            assign_component(
                edges[edge_idx].from_idx,
                incoming,
                edges,
                component,
                component_of,
                members,
            );
        }
    }

    let mut seen = vec![false; node_count];
    let mut finish = Vec::with_capacity(node_count);
    for node in 0..node_count {
        visit(node, &outgoing, &edges_data, &mut seen, &mut finish);
    }

    let mut component_of = vec![usize::MAX; node_count];
    let mut components: Vec<Vec<usize>> = Vec::new();
    for &node in finish.iter().rev() {
        if component_of[node] != usize::MAX {
            continue;
        }
        let component = components.len();
        let mut members = Vec::new();
        assign_component(
            node,
            &incoming,
            &edges_data,
            component,
            &mut component_of,
            &mut members,
        );
        members.sort_by(|a, b| {
            node_order_idx[*a]
                .cmp(&node_order_idx[*b])
                .then_with(|| node_ids[*a].cmp(&node_ids[*b]))
        });
        components.push(members);
    }

    let has_cycle = components.iter().any(|members| members.len() > 1)
        || edges_data.iter().any(|edge| edge.from_idx == edge.to_idx);
    let mut weak_seen = vec![false; node_count];
    let mut weak_component_count = 0usize;
    for start in 0..node_count {
        if weak_seen[start] {
            continue;
        }
        weak_component_count += 1;
        let mut stack = vec![start];
        weak_seen[start] = true;
        while let Some(node) = stack.pop() {
            for &edge_idx in outgoing[node].iter().chain(&incoming[node]) {
                let edge = &edges_data[edge_idx];
                let neighbor = if edge.from_idx == node {
                    edge.to_idx
                } else {
                    edge.from_idx
                };
                if !weak_seen[neighbor] {
                    weak_seen[neighbor] = true;
                    stack.push(neighbor);
                }
            }
        }
    }
    // Keep the established geometry byte-for-byte for ordinary connected
    // acyclic Sankey diagrams. Extra packing is only needed where the old
    // algorithm collapsed cycles or placed disconnected components on top of
    // each other.
    let requires_compaction = has_cycle || weak_component_count > 1;

    let component_count = components.len();
    let mut component_outgoing = vec![BTreeSet::new(); component_count];
    let mut component_indegree = vec![0usize; component_count];
    for edge in &edges_data {
        let from = component_of[edge.from_idx];
        let to = component_of[edge.to_idx];
        if from != to && component_outgoing[from].insert(to) {
            component_indegree[to] += 1;
        }
    }

    let component_key = |component: usize| components[component][0];
    let mut ready = BTreeSet::new();
    for (component, &degree) in component_indegree.iter().enumerate() {
        if degree == 0 {
            ready.insert((component_key(component), component));
        }
    }
    let mut component_rank = vec![0usize; component_count];
    while let Some(&(key, component)) = ready.iter().next() {
        ready.remove(&(key, component));
        let next_rank = component_rank[component] + components[component].len();
        for &target in &component_outgoing[component] {
            component_rank[target] = component_rank[target].max(next_rank);
            component_indegree[target] -= 1;
            if component_indegree[target] == 0 {
                ready.insert((component_key(target), target));
            }
        }
    }

    let mut ranks = vec![0usize; node_count];
    for (component, members) in components.iter().enumerate() {
        for (offset, &node) in members.iter().enumerate() {
            ranks[node] = component_rank[component] + offset;
        }
    }

    let max_rank = ranks.iter().copied().max().unwrap_or(0);
    let num_ranks = max_rank + 1;
    let sankey_width = (SANKEY_MIN_WIDTH + num_ranks.saturating_sub(2) as f32 * 25.0)
        .clamp(SANKEY_MIN_WIDTH, SANKEY_MAX_WIDTH);
    let gap_x = if num_ranks > 1 {
        ((sankey_width - SANKEY_NODE_WIDTH * num_ranks as f32) / (num_ranks - 1) as f32).max(0.0)
    } else {
        0.0
    };

    let mut totals = vec![0.0f32; node_count];
    for idx in 0..node_count {
        let total = in_total[idx].max(out_total[idx]);
        totals[idx] = if total > 0.0 { total } else { 1.0 };
    }
    let scale = if requires_compaction {
        let mut rank_totals = vec![0.0f32; num_ranks];
        let mut rank_counts = vec![0usize; num_ranks];
        for idx in 0..node_count {
            rank_totals[ranks[idx]] += totals[idx];
            rank_counts[ranks[idx]] += 1;
        }
        let scale = rank_totals
            .iter()
            .zip(&rank_counts)
            .filter(|&(&total, _)| total > 0.0)
            .map(|(&total, &count)| {
                let gaps = count.saturating_sub(1) as f32 * SANKEY_NODE_GAP;
                ((SANKEY_HEIGHT - gaps).max(0.0) / total).max(0.0)
            })
            .fold(f32::INFINITY, f32::min);
        if scale.is_finite() { scale } else { 1.0 }
    } else {
        let max_total = totals.iter().copied().fold(0.0, f32::max).max(1.0);
        SANKEY_HEIGHT / max_total
    };

    let mut node_x = vec![0.0f32; node_count];
    let mut node_y = vec![0.0f32; node_count];
    let mut node_h = vec![0.0f32; node_count];
    for idx in 0..node_count {
        let rank = ranks[idx];
        node_x[idx] = rank as f32 * (SANKEY_NODE_WIDTH + gap_x);
        node_h[idx] = totals[idx] * scale;
    }

    let mut rank_nodes: Vec<Vec<usize>> = vec![Vec::new(); num_ranks];
    for idx in 0..node_count {
        rank_nodes[ranks[idx]].push(idx);
    }
    for nodes_in_rank in &mut rank_nodes {
        nodes_in_rank.sort_by(|a, b| {
            node_order_idx[*a]
                .cmp(&node_order_idx[*b])
                .then_with(|| node_ids[*a].cmp(&node_ids[*b]))
        });
        if requires_compaction {
            let mut y = 0.0;
            for &idx in nodes_in_rank.iter() {
                node_y[idx] = y;
                y += node_h[idx] + SANKEY_NODE_GAP;
            }
        }
    }

    let mut outbound_order = outgoing.clone();
    for edges in &mut outbound_order {
        edges.sort_by(|a, b| {
            let target_a = edges_data[*a].to_idx;
            let target_b = edges_data[*b].to_idx;
            ranks[target_b]
                .cmp(&ranks[target_a])
                .then_with(|| node_order_idx[target_a].cmp(&node_order_idx[target_b]))
                .then_with(|| node_ids[target_a].cmp(&node_ids[target_b]))
        });
    }

    let edge_thickness: Vec<f32> = edges_data.iter().map(|edge| edge.value * scale).collect();
    let mut link_top = vec![0.0f32; edges_data.len()];
    let mut outbound_offset = vec![0.0f32; edges_data.len()];
    let mut acc = vec![0.0f32; node_count];

    fn compute_link_tops(
        node_positions: &[f32],
        outbound_order: &[Vec<usize>],
        edge_thickness: &[f32],
        link_top: &mut [f32],
        outbound_offset: &mut [f32],
        acc: &mut [f32],
    ) {
        link_top.fill(0.0);
        outbound_offset.fill(0.0);
        acc.fill(0.0);
        for source_idx in 0..outbound_order.len() {
            for &edge_idx in &outbound_order[source_idx] {
                let offset = acc[source_idx];
                outbound_offset[edge_idx] = offset;
                link_top[edge_idx] = node_positions[source_idx] + offset;
                acc[source_idx] += edge_thickness[edge_idx];
            }
        }
    }

    for rank in 1..=max_rank {
        compute_link_tops(
            &node_y,
            &outbound_order,
            &edge_thickness,
            &mut link_top,
            &mut outbound_offset,
            &mut acc,
        );
        for &node_idx in &rank_nodes[rank] {
            let mut min_top = f32::INFINITY;
            for &edge_idx in &incoming[node_idx] {
                let from_idx = edges_data[edge_idx].from_idx;
                if ranks[from_idx] >= rank {
                    continue;
                }
                min_top = min_top.min(link_top[edge_idx]);
            }
            if !min_top.is_finite() {
                continue;
            }
            let max_y = (SANKEY_HEIGHT - node_h[node_idx]).max(0.0);
            node_y[node_idx] = min_top.clamp(0.0, max_y);
        }
    }
    // Alignment may pull multiple nodes onto the same y. Pack every rank once
    // more, preserving desired positions where possible while guaranteeing
    // the configured gap and keeping the rank inside the canvas.
    if requires_compaction {
        for nodes_in_rank in &rank_nodes {
            let mut y = 0.0;
            for &idx in nodes_in_rank {
                node_y[idx] = node_y[idx].max(y);
                y = node_y[idx] + node_h[idx] + SANKEY_NODE_GAP;
            }
            let bottom = nodes_in_rank
                .last()
                .map(|&idx| node_y[idx] + node_h[idx])
                .unwrap_or(0.0);
            if bottom > SANKEY_HEIGHT {
                let shift = bottom - SANKEY_HEIGHT;
                for &idx in nodes_in_rank {
                    node_y[idx] = (node_y[idx] - shift).max(0.0);
                }
                let mut y = 0.0;
                for &idx in nodes_in_rank {
                    node_y[idx] = node_y[idx].max(y);
                    y = node_y[idx] + node_h[idx] + SANKEY_NODE_GAP;
                }
            }
        }
    }
    compute_link_tops(
        &node_y,
        &outbound_order,
        &edge_thickness,
        &mut link_top,
        &mut outbound_offset,
        &mut acc,
    );
    let mut inbound_offsets = vec![0.0f32; edges_data.len()];
    if requires_compaction {
        for target_idx in 0..node_count {
            let mut ordered = incoming[target_idx].clone();
            ordered.sort_by(|a, b| {
                let source_center = |edge_idx: usize| {
                    let source = edges_data[edge_idx].from_idx;
                    node_y[source] + outbound_offset[edge_idx] + edge_thickness[edge_idx] / 2.0
                };
                source_center(*a)
                    .partial_cmp(&source_center(*b))
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.cmp(b))
            });
            let mut offset = 0.0;
            for edge_idx in ordered {
                inbound_offsets[edge_idx] = offset;
                offset += edge_thickness[edge_idx];
            }
        }
    }

    let mut node_colors = Vec::with_capacity(node_count);
    for idx in 0..node_count {
        let default_color = SANKEY_PALETTE[idx % SANKEY_PALETTE.len()].to_string();
        let mut style = resolve_node_style(node_ids[idx].as_str(), graph);
        let color = style.fill.clone().unwrap_or(default_color);
        if style.fill.is_none() {
            style.fill = Some(color.clone());
        }
        if style.stroke.is_none() {
            style.stroke = Some("none".to_string());
        }
        if style.stroke_width.is_none() {
            style.stroke_width = Some(0.0);
        }
        node_colors.push((color, style));
    }

    let mut nodes = BTreeMap::new();
    let mut sankey_nodes = Vec::with_capacity(node_count);
    for idx in 0..node_count {
        let id = node_ids[idx].clone();
        let label = graph
            .nodes
            .get(&id)
            .map(|node| node.label.clone())
            .unwrap_or_else(|| id.clone());
        let (color, style) = &node_colors[idx];
        let label_block = measure_label(&label, theme, config);
        nodes.insert(
            id.clone(),
            NodeLayout {
                id: id.clone(),
                x: node_x[idx],
                y: node_y[idx],
                width: SANKEY_NODE_WIDTH,
                height: node_h[idx],
                label: label_block,
                shape: crate::ir::NodeShape::Rectangle,
                style: style.clone(),
                link: graph.node_links.get(&id).cloned(),
                anchor_subgraph: None,
                hidden: false,
                icon: None,
            },
        );
        sankey_nodes.push(SankeyNodeLayout {
            id: id.clone(),
            label,
            total: totals[idx],
            rank: ranks[idx],
            x: node_x[idx],
            y: node_y[idx],
            width: SANKEY_NODE_WIDTH,
            height: node_h[idx],
            color: color.clone(),
        });
    }

    let mut edges = Vec::with_capacity(edges_data.len());
    let mut sankey_links = Vec::with_capacity(edges_data.len());
    for (edge_idx, edge) in edges_data.iter().enumerate() {
        let from_id = node_ids[edge.from_idx].clone();
        let to_id = node_ids[edge.to_idx].clone();
        let thickness = edge_thickness[edge_idx];
        if thickness <= 0.0 {
            continue;
        }
        let start_x = node_x[edge.from_idx] + SANKEY_NODE_WIDTH;
        let end_x = node_x[edge.to_idx];
        let start_y = node_y[edge.from_idx] + outbound_offset[edge_idx] + thickness / 2.0;
        let inbound_offset = if requires_compaction {
            inbound_offsets[edge_idx]
        } else {
            (link_top[edge_idx] - node_y[edge.to_idx]).max(0.0)
        };
        let end_y = node_y[edge.to_idx] + inbound_offset + thickness / 2.0;
        let (color_start, _) = &node_colors[edge.from_idx];
        let (color_end, _) = &node_colors[edge.to_idx];
        let gradient_id = format!("sankey-grad-{edge_idx}");

        edges.push(EdgeLayout {
            from: from_id.clone(),
            to: to_id.clone(),
            label: None,
            start_label: None,
            end_label: None,
            label_anchor: None,
            start_label_anchor: None,
            end_label_anchor: None,
            points: vec![(start_x, start_y), (end_x, end_y)],
            directed: false,
            arrow_start: false,
            arrow_end: false,
            arrow_start_kind: None,
            arrow_end_kind: None,
            start_decoration: None,
            end_decoration: None,
            style: crate::ir::EdgeStyle::Solid,
            override_style: crate::ir::EdgeStyleOverride {
                stroke: Some(color_start.clone()),
                stroke_width: Some(thickness),
                dasharray: None,
                label_color: None,
            },
        });
        sankey_links.push(SankeyLinkLayout {
            source: from_id,
            target: to_id,
            value: edge.value,
            thickness,
            start: (start_x, start_y),
            end: (end_x, end_y),
            color_start: color_start.clone(),
            color_end: color_end.clone(),
            gradient_id,
        });
    }

    Layout {
        kind: graph.kind,
        nodes,
        edges,
        subgraphs: Vec::new(),
        width: sankey_width,
        height: SANKEY_HEIGHT,
        diagram: DiagramData::Sankey(SankeyLayout {
            width: sankey_width,
            height: SANKEY_HEIGHT,
            node_width: SANKEY_NODE_WIDTH,
            nodes: sankey_nodes,
            links: sankey_links,
        }),
    }
}
