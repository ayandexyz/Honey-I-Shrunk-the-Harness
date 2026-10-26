//! Approve/deny card for a tool call the runtime wants permission for.
//!
//! freecode addition: upstream Jcode runs tools without asking, so its
//! desktop only played a sound on `PermissionRequest`. freecode's core asks
//! (build mode, per-rule `ask`), and an unanswered request blocks the turn
//! until core's timeout, which counts as deny. Kept in its own file so the
//! upstream panel needs only small hooks (spec
//! `docs/specs/2026-10-26-jcode-sdk-shim-contract.md`, Phase 4).
use super::*;
use jcode_sdk::PermissionDecision;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Request {
    pub id: String,
    pub tool: String,
    pub description: String,
}

/// Requests waiting for an answer, oldest first.
#[derive(Default)]
pub(super) struct PendingPermissions(VecDeque<Request>);

impl PendingPermissions {
    pub(super) fn observe(&mut self, event: &ApiEvent) {
        match event {
            ApiEvent::PermissionRequest {
                request_id,
                tool_name,
                description,
                ..
            } => {
                if !self.0.iter().any(|r| &r.id == request_id) {
                    self.0.push_back(Request {
                        id: request_id.clone(),
                        tool: tool_name.clone(),
                        description: description.clone(),
                    });
                }
            }
            // A finished or failed turn takes its open asks with it.
            ApiEvent::TurnDone { .. } | ApiEvent::TurnStopped { .. } | ApiEvent::Error { .. } => {
                self.0.clear()
            }
            _ => {}
        }
    }

    pub(super) fn front(&self) -> Option<&Request> {
        self.0.front()
    }

    fn take(&mut self, id: &str) {
        self.0.retain(|r| r.id != id);
    }
}

impl Panel {
    pub(super) fn render_permission_card(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let request = self.permission_requests.front()?.clone();
        let waiting = self.permission_requests.0.len();
        let theme = Theme::global();
        let pill = |id: &'static str, label: &'static str, primary: bool| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .px_3()
                .h(px(26.0))
                .flex()
                .items_center()
                .rounded_full()
                .cursor_pointer()
                .text_size(px(12.0))
                .when(primary, |el| el.bg(theme.ACCENT).text_color(theme.BG))
                .when(!primary, |el| {
                    el.bg(theme.TOOL_BG)
                        .text_color(theme.TEXT_DIM)
                        .hover(|el| el.text_color(theme.TEXT))
                })
                .child(label)
        };
        let answer = |decision: PermissionDecision| {
            let id = request.id.clone();
            cx.listener(move |panel: &mut Panel, _, _, cx| {
                panel.permission_requests.take(&id);
                panel.bridge.send(Command::RespondPermission {
                    session_id: panel.session_id.clone(),
                    request_id: id.clone(),
                    decision,
                });
                cx.notify();
            })
        };
        let title = match waiting {
            1 => format!("Allow {}?", request.tool),
            n => format!("Allow {}? ({n} waiting)", request.tool),
        };
        Some(
            div()
                .debug_selector(|| "permission-card".into())
                .p_3()
                .rounded_xl()
                .bg(theme.PANEL_BG)
                .shadow_lg()
                .occlude()
                .flex()
                .flex_col()
                .gap_2()
                .child(div().font_weight(FontWeight::SEMIBOLD).child(title))
                .when(!request.description.is_empty(), |el| {
                    el.child(
                        div()
                            .text_size(px(12.0))
                            .font_family(theme.FONT_MONO)
                            .text_color(theme.TEXT_DIM)
                            .child(request.description.clone()),
                    )
                })
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .justify_end()
                        .child(pill("permission-deny", "Deny", false).on_click(answer(PermissionDecision::Deny)))
                        .child(
                            pill("permission-always", "Always allow", false)
                                .on_click(answer(PermissionDecision::AllowAlways)),
                        )
                        .child(pill("permission-allow", "Allow", true).on_click(answer(PermissionDecision::Allow))),
                )
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(id: &str) -> ApiEvent {
        ApiEvent::PermissionRequest {
            session_id: "s".into(),
            request_id: id.into(),
            tool_name: "bash".into(),
            description: "ls".into(),
        }
    }

    #[test]
    fn queues_once_per_request_and_clears_when_the_turn_ends() {
        let mut pending = PendingPermissions::default();
        pending.observe(&ask("a"));
        pending.observe(&ask("a"));
        pending.observe(&ask("b"));
        assert_eq!(pending.0.len(), 2);
        pending.take("a");
        assert_eq!(pending.front().map(|r| r.id.as_str()), Some("b"));
        pending.observe(&ApiEvent::TurnDone {
            session_id: "s".into(),
            pending_soft_interrupts: None,
        });
        assert!(pending.front().is_none());
    }
}
