use std::collections::BTreeMap;

use crate::config::LayoutConfig;
use crate::ir::{DiagramKind, Direction, Graph};
use crate::theme::Theme;

use super::super::{
    DiagramData, EdgeLayout, LAYOUT_BOUNDARY_PAD, Layout, NodeLayout, STATE_NOTE_GAP_MIN,
    STATE_NOTE_GAP_SCALE, STATE_NOTE_PAD_X_SCALE, STATE_NOTE_PAD_Y_SCALE, StateNoteLayout,
    SubgraphLayout, apply_direction_mirror, bounds_with_edges, measure_label, normalize_layout,
};

pub(in crate::layout) fn finalize_graph_layout(
    graph: &Graph,
    mut nodes: BTreeMap<String, NodeLayout>,
    mut edges: Vec<EdgeLayout>,
    mut subgraphs: Vec<SubgraphLayout>,
    theme: &Theme,
    config: &LayoutConfig,
) -> Layout {
    if matches!(graph.direction, Direction::RightLeft | Direction::BottomTop) {
        apply_direction_mirror(graph.direction, &mut nodes, &mut edges, &mut subgraphs);
    }

    normalize_layout(&mut nodes, &mut edges, &mut subgraphs);
    let mut state_notes = Vec::new();
    if graph.kind == DiagramKind::State && !graph.state_notes.is_empty() {
        // Routed edges already contain their final label anchors here. Keeping
        // note placement after the edge pipeline prevents later label passes
        // from moving labels into notes.
        let note_pad_x = theme.font_size * STATE_NOTE_PAD_X_SCALE;
        let note_pad_y = theme.font_size * STATE_NOTE_PAD_Y_SCALE;
        let note_gap = (theme.font_size * STATE_NOTE_GAP_SCALE).max(STATE_NOTE_GAP_MIN);
        for note in &graph.state_notes {
            // Composite state targets keep only a hidden anchor node inside
            // their subgraph, so anchor the note to the subgraph bounds.
            let Some((tx, ty, tw, th)) =
                state_note_target_rect(&note.target, graph, &nodes, &subgraphs)
            else {
                continue;
            };
            let label = measure_label(&note.label, theme, config);
            let width = label.width + note_pad_x * 2.0;
            let height = label.height + note_pad_y * 2.0;
            let y = ty + th / 2.0 - height / 2.0;
            let initial_x = match note.position {
                crate::ir::StateNotePosition::LeftOf => tx - note_gap - width,
                crate::ir::StateNotePosition::RightOf => tx + tw + note_gap,
            };
            let x = clear_state_note_x(
                initial_x,
                y,
                width,
                height,
                note_gap,
                note.position,
                &note.target,
                graph,
                &nodes,
                &subgraphs,
                &edges,
                &state_notes,
            );
            state_notes.push(StateNoteLayout {
                x,
                y,
                width,
                height,
                label,
                position: note.position,
                target: note.target.clone(),
            });
        }
    }
    let (mut max_x, mut max_y) = bounds_with_edges(&nodes, &subgraphs, &edges);
    for note in &state_notes {
        max_x = max_x.max(note.x + note.width);
        max_y = max_y.max(note.y + note.height);
    }
    let width = max_x + LAYOUT_BOUNDARY_PAD;
    let height = max_y + LAYOUT_BOUNDARY_PAD;

    Layout {
        kind: graph.kind,
        nodes,
        edges,
        subgraphs,
        width,
        height,
        diagram: DiagramData::Graph { state_notes },
    }
}

#[allow(clippy::too_many_arguments)]
fn clear_state_note_x(
    mut x: f32,
    y: f32,
    width: f32,
    height: f32,
    gap: f32,
    position: crate::ir::StateNotePosition,
    target: &str,
    graph: &Graph,
    nodes: &BTreeMap<String, NodeLayout>,
    subgraphs: &[SubgraphLayout],
    edges: &[EdgeLayout],
    notes: &[StateNoteLayout],
) -> f32 {
    let target_subgraph = graph.subgraphs.iter().find(|sub| {
        sub.id.as_deref() == Some(target) || (!sub.label.is_empty() && sub.label == target)
    });
    let clear_rect = |x: f32, rx: f32, ry: f32, rw: f32, rh: f32| {
        if y >= ry + rh || y + height <= ry || x >= rx + rw || x + width <= rx {
            return x;
        }
        match position {
            crate::ir::StateNotePosition::LeftOf => rx - gap - width,
            crate::ir::StateNotePosition::RightOf => rx + rw + gap,
        }
    };

    // Repeating the stable traversal handles a move that exposes a later obstacle.
    loop {
        let before = x;
        for (id, node) in nodes {
            if id != target && !node.hidden {
                x = clear_rect(x, node.x, node.y, node.width, node.height);
            }
        }
        for subgraph in subgraphs {
            let is_target = target_subgraph
                .is_some_and(|sub| subgraph.label == sub.label && subgraph.nodes == sub.nodes);
            if !is_target {
                x = clear_rect(x, subgraph.x, subgraph.y, subgraph.width, subgraph.height);
            }
        }
        for note in notes {
            x = clear_rect(x, note.x, note.y, note.width, note.height);
        }
        for edge in edges {
            for (label, anchor) in [
                (&edge.label, edge.label_anchor),
                (&edge.start_label, edge.start_label_anchor),
                (&edge.end_label, edge.end_label_anchor),
            ] {
                if let (Some(label), Some((cx, cy))) = (label, anchor) {
                    x = clear_rect(
                        x,
                        cx - label.width / 2.0,
                        cy - label.height / 2.0,
                        label.width,
                        label.height,
                    );
                }
            }
            for segment in edge.points.windows(2) {
                let stroke_width = edge
                    .override_style
                    .stroke_width
                    // Keep this in sync with the graph-edge default in render.rs.
                    .unwrap_or(1.5)
                    .max(0.0);
                let stroke_pad = stroke_width / 2.0;
                if segment_intersects_rect(
                    segment[0],
                    segment[1],
                    (x, y, width, height),
                    stroke_pad,
                ) {
                    let min_x = segment[0].0.min(segment[1].0) - stroke_pad;
                    let max_x = segment[0].0.max(segment[1].0) + stroke_pad;
                    x = match position {
                        crate::ir::StateNotePosition::LeftOf => min_x - gap - width,
                        crate::ir::StateNotePosition::RightOf => max_x + gap,
                    };
                }
            }
        }
        if x == before {
            break;
        }
    }
    x
}

fn segment_intersects_rect(
    a: (f32, f32),
    b: (f32, f32),
    (x, y, width, height): (f32, f32, f32, f32),
    padding: f32,
) -> bool {
    let left = x - padding;
    let right = x + width + padding;
    let top = y - padding;
    let bottom = y + height + padding;
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    let mut entry = 0.0f32;
    let mut exit = 1.0f32;

    for (p, q) in [
        (-dx, a.0 - left),
        (dx, right - a.0),
        (-dy, a.1 - top),
        (dy, bottom - a.1),
    ] {
        if p.abs() <= f32::EPSILON {
            if q < 0.0 {
                return false;
            }
            continue;
        }
        let t = q / p;
        if p < 0.0 {
            entry = entry.max(t);
        } else {
            exit = exit.min(t);
        }
        if entry > exit {
            return false;
        }
    }
    true
}

/// Resolves the rectangle a state note should attach to.
///
/// Simple states resolve to their node layout. Composite states are laid out
/// as subgraphs whose graph node is a hidden anchor, so notes targeting them
/// attach to the subgraph bounds instead.
fn state_note_target_rect(
    target: &str,
    graph: &Graph,
    nodes: &BTreeMap<String, NodeLayout>,
    subgraphs: &[SubgraphLayout],
) -> Option<(f32, f32, f32, f32)> {
    let node = nodes.get(target);
    if let Some(node) = node
        && !node.hidden
    {
        return Some((node.x, node.y, node.width, node.height));
    }
    let sub = graph.subgraphs.iter().find(|sub| {
        sub.id.as_deref() == Some(target) || (!sub.label.is_empty() && sub.label == target)
    });
    if let Some(sub) = sub
        && let Some(layout) = subgraphs
            .iter()
            .find(|layout| layout.label == sub.label && layout.nodes == sub.nodes)
    {
        return Some((layout.x, layout.y, layout.width, layout.height));
    }
    node.map(|node| (node.x, node.y, node.width, node.height))
}

#[cfg(test)]
mod tests {
    use super::segment_intersects_rect;

    #[test]
    fn diagonal_segment_does_not_reserve_its_full_bounding_box() {
        let segment = ((0.0, 0.0), (100.0, 100.0));

        assert!(!segment_intersects_rect(
            segment.0,
            segment.1,
            (70.0, 10.0, 20.0, 20.0),
            1.0,
        ));
        assert!(segment_intersects_rect(
            segment.0,
            segment.1,
            (45.0, 45.0, 10.0, 10.0),
            1.0,
        ));
    }

    #[test]
    fn segment_clearance_includes_half_the_stroke_width() {
        let segment = ((0.0, 10.0), (100.0, 10.0));
        let rect = (40.0, 11.5, 20.0, 10.0);

        assert!(!segment_intersects_rect(segment.0, segment.1, rect, 1.0));
        assert!(segment_intersects_rect(segment.0, segment.1, rect, 2.0));
    }
}
