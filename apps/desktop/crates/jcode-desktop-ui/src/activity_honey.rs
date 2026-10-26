//! freecode: Honey's idle mark — a dotted "H" in the thinking-orbs dot
//! vocabulary, replacing upstream's Jcode donut (`activity_donut.rs`, kept
//! intact so its tests and upstream pulls stay clean). Same `Frame`/`Dot`
//! paint path, so it morphs to and from every orb preset like the donut did.

use gpui_thinking_orbs::{Dot, Frame, sanitize_size, sort_dots};

/// 5×7 dot matrix of a block "H".
const GLYPH: [&str; 7] = ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"];

pub(super) fn draw_honey_into(size: f32, out: &mut Frame) {
    out.clear();
    let size = sanitize_size(size);
    let rows = GLYPH.len() as f32;
    let cols = GLYPH[0].len() as f32;
    // Fill ~60% of the box, leaving the same margin the donut kept.
    let pitch = 0.6 / rows.max(cols);
    let (left, top) = (0.5 - pitch * (cols - 1.0) / 2.0, 0.5 - pitch * (rows - 1.0) / 2.0);
    for (row, line) in GLYPH.iter().enumerate() {
        for (col, cell) in line.chars().enumerate() {
            if cell != '#' {
                continue;
            }
            // A slight top-left light keeps the depth cue of the donut.
            let shade = (row + col) as f32 / (rows + cols);
            out.dots.push(
                Dot::new(
                    size * (left + pitch * col as f32),
                    size * (top + pitch * row as f32),
                    0.0,
                    size * 0.03,
                    0.08 + 0.18 * shade,
                )
                .with_a(1.0),
            );
        }
    }
    sort_dots(&mut out.dots);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn honey_mark_is_an_h_inside_the_box() {
        let mut frame = Frame::new();
        draw_honey_into(20.0, &mut frame);
        assert_eq!(frame.dots.len(), 17, "5×7 H has 17 dots");
        for dot in &frame.dots {
            assert!((0.0..=20.0).contains(&dot.x) && (0.0..=20.0).contains(&dot.y), "{dot:?}");
        }
        // The crossbar row is solid: five dots share the middle y.
        let middle = frame.dots.iter().filter(|d| (d.y - 10.0).abs() < 0.01).count();
        assert_eq!(middle, 5);
    }
}
