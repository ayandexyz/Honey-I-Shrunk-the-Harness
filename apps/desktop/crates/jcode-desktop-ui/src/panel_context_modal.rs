//! `/context` modal: core's `context.stats` breakdown as one stacked bar and a
//! legend — the desktop counterpart of the TUI's context grid. Pure
//! presentation: every number comes from core, colors come from the theme.
use super::*;
use serde::Deserialize;

/// Mirrors the parts of `ContextBreakdown` (packages/shared) the modal shows.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ContextStats {
    pub(crate) model: Option<String>,
    pub(crate) context_limit: Option<u64>,
    pub(crate) segments: Vec<ContextSegment>,
    pub(crate) used_tokens: u64,
    pub(crate) measured_input_tokens: Option<u64>,
    pub(crate) message_count: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub(crate) struct ContextSegment {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) tokens: u64,
}

impl ContextStats {
    /// `None` when the reply is not a breakdown, so the caller can fall back
    /// to the plain text summary instead of showing an empty modal.
    pub(crate) fn from_data(data: &serde_json::Value) -> Option<Self> {
        data.get("segments")?;
        serde_json::from_value(data.clone()).ok()
    }

    /// The bar's denominator: the window when known, else what is used, so an
    /// unknown limit shows composition rather than a made-up occupancy.
    fn whole(&self) -> u64 {
        self.context_limit
            .filter(|limit| *limit > 0)
            .unwrap_or(self.used_tokens)
    }

    /// Non-empty segments, biggest first — "what is eating my window".
    fn ranked(&self) -> Vec<&ContextSegment> {
        let mut segments: Vec<_> = self.segments.iter().filter(|s| s.tokens > 0).collect();
        segments.sort_by(|a, b| b.tokens.cmp(&a.tokens));
        segments
    }
}

/// One theme color per category, so bar and legend read as one object and
/// follow the active theme.
fn segment_color(id: &str, theme: &Theme) -> gpui::Rgba {
    match id {
        "system-prompt" => theme.CODE_CONSTANT,
        "project-instructions" => theme.CODE_FUNCTION,
        "skills" => theme.CODE_STRING,
        "agent-types" => theme.CODE_TYPE,
        "memory-guidance" => theme.CODE_ATTRIBUTE,
        "tools" => theme.CODE_KEYWORD,
        "mcp-tools" => theme.CODE_TAG,
        "compaction-summary" => theme.WARN,
        "memories" => theme.CODE_NUMBER,
        "todos" => theme.OK,
        "project-context" => theme.LINK,
        "messages" => theme.ACCENT,
        _ => theme.TEXT_DIM,
    }
}

fn percent(part: u64, whole: u64) -> String {
    if whole == 0 {
        return "—".into();
    }
    let pct = part as f64 / whole as f64 * 100.0;
    if pct < 0.1 && part > 0 {
        "<0.1%".into()
    } else {
        format!("{pct:.1}%")
    }
}

impl Panel {
    pub(super) fn close_context_modal(&mut self, cx: &mut Context<Self>) {
        self.context_modal = None;
        cx.notify();
    }

    pub(super) fn render_context_modal(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let stats = self.context_modal.as_ref()?;
        let theme = Theme::global();
        let whole = stats.whole();
        let limit = stats.context_limit.filter(|limit| *limit > 0);
        let model = stats.model.clone().unwrap_or_else(|| "unknown model".into());
        let subtitle = match limit {
            Some(limit) => format!("{model} · {} token context window", format_tokens(limit)),
            None => format!("{model} · context limit unknown"),
        };
        let summary = match limit {
            Some(limit) => format!(
                "{} of {} used ({}) · {} messages",
                format_tokens(stats.used_tokens),
                format_tokens(limit),
                percent(stats.used_tokens, limit),
                stats.message_count
            ),
            None => format!(
                "{} used · {} messages",
                format_tokens(stats.used_tokens),
                stats.message_count
            ),
        };
        let ranked = stats.ranked();

        let bar = div()
            .debug_selector(|| "context-modal-bar".into())
            .w_full()
            .h(px(10.0))
            .flex()
            .rounded_full()
            .overflow_hidden()
            .bg(theme.MINIMAP_TRACK)
            .children(ranked.iter().map(|segment| {
                let fraction = if whole == 0 {
                    0.0
                } else {
                    (segment.tokens as f32 / whole as f32).min(1.0)
                };
                div()
                    .flex_none()
                    .h_full()
                    .w(relative(fraction))
                    .min_w(px(2.0))
                    .bg(segment_color(&segment.id, theme))
            }));

        let row = |color: gpui::Rgba, label: String, tokens: u64| {
            div()
                .flex()
                .items_center()
                .gap_2()
                .px_3()
                .h(px(24.0))
                .rounded_full()
                .bg(theme.TOOL_BG)
                .text_size(px(11.0))
                .child(div().flex_none().size(px(8.0)).rounded_full().bg(color))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(theme.TEXT)
                        .child(label),
                )
                .child(
                    div()
                        .flex_none()
                        .text_color(theme.TEXT)
                        .child(format_tokens(tokens)),
                )
                .child(
                    div()
                        .flex_none()
                        .w(px(44.0))
                        .text_right()
                        .text_color(theme.TEXT_DIM)
                        .child(percent(tokens, whole)),
                )
        };
        let legend = div()
            .id("context-modal-legend")
            .debug_selector(|| "context-modal-legend".into())
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_1()
            .children(ranked.iter().map(|segment| {
                row(
                    segment_color(&segment.id, theme),
                    segment.label.clone(),
                    segment.tokens,
                )
            }))
            .when_some(limit, |el, limit| {
                el.child(row(
                    theme.MINIMAP_TRACK,
                    "Free space".into(),
                    limit.saturating_sub(stats.used_tokens),
                ))
            });

        let card = div()
            .id("context-modal")
            .debug_selector(|| "context-modal".into())
            .w(relative(0.9))
            .max_w(px(440.0))
            .max_h(relative(0.8))
            .flex()
            .flex_col()
            .gap_3()
            .p_4()
            .rounded_xl()
            .bg(theme.HEADER_BG)
            .border_1()
            .border_color(theme.PANEL_BORDER)
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap_3()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .text_size(px(13.0))
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .text_color(theme.TEXT)
                                    .child("Context usage"),
                            )
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(10.0))
                                    .text_color(theme.TEXT_DIM)
                                    .child(subtitle),
                            ),
                    )
                    .child(
                        div()
                            .id("context-modal-close")
                            .debug_selector(|| "context-modal-close".into())
                            .flex_none()
                            .px_2()
                            .py_1()
                            .rounded_full()
                            .cursor_pointer()
                            .text_size(px(11.0))
                            .text_color(theme.TEXT_DIM)
                            .hover(|el| el.bg(theme.TOOL_BG))
                            .child("Close · Esc")
                            .on_click(cx.listener(|this, _, _, cx| this.close_context_modal(cx))),
                    ),
            )
            .child(bar)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .text_size(px(11.0))
                    .text_color(theme.TEXT_DIM)
                    .child(summary)
                    .when_some(stats.measured_input_tokens, |el, measured| {
                        el.child(format!(
                            "Last turn measured by the provider: {} tokens",
                            format_tokens(measured)
                        ))
                    }),
            )
            .child(legend);

        Some(
            div()
                .id("context-modal-backdrop")
                .debug_selector(|| "context-modal-backdrop".into())
                .absolute()
                .inset_0()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(gpui::Rgba { a: 0.6, ..theme.PANEL_BG })
                .occlude()
                .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
                .on_mouse_down(
                    gpui::MouseButton::Left,
                    cx.listener(|this, _, _, cx| {
                        this.close_context_modal(cx);
                        cx.stop_propagation();
                    }),
                )
                .child(card)
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_core_breakdown_and_ranks_non_empty_segments() {
        let data = serde_json::json!({
            "provider": "anthropic",
            "model": "claude-sonnet-5",
            "contextLimit": 1_000_000,
            "usedTokens": 34_000,
            "messageCount": 4,
            "toolCount": 20,
            "mcpToolCount": 0,
            "segments": [
                { "id": "skills", "label": "Skills", "tokens": 13_100 },
                { "id": "todos", "label": "Todos", "tokens": 0 },
                { "id": "project-instructions", "label": "Project instructions", "tokens": 20_800 },
            ],
        });
        let stats = ContextStats::from_data(&data).expect("breakdown");
        let ranked: Vec<_> = stats.ranked().iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ranked, ["project-instructions", "skills"]);
        assert_eq!(stats.whole(), 1_000_000);
        assert_eq!(percent(20_800, 1_000_000), "2.1%");
        assert_eq!(percent(50, 1_000_000), "<0.1%");
    }

    #[test]
    fn unknown_limit_measures_composition_and_non_breakdowns_are_ignored() {
        let stats = ContextStats::from_data(&serde_json::json!({
            "usedTokens": 900,
            "segments": [{ "id": "tools", "label": "Tool definitions", "tokens": 900 }],
        }))
        .unwrap();
        assert_eq!(stats.whole(), 900);
        assert!(ContextStats::from_data(&serde_json::json!({ "provider": "x" })).is_none());
    }
}
