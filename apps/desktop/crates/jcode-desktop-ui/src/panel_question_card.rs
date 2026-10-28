//! Answer card for the `question` tool (ask the user a free-form question
//! with preset options, plus a free-text "Other" escape hatch).
//!
//! freecode addition, mirroring `panel_permission_card.rs`: jcode's own
//! ApiEvent has nothing like this (its only interactive ask is
//! `PermissionRequest`), so the shim smuggles the payload inside
//! `ApiEvent::RuntimeCommandResult` — see `jcode_sdk::question` for why that
//! carrier is safe to reuse. This file only ever sees the already-parsed
//! `jcode_sdk::QuestionPayload`, not the raw envelope.
use super::*;

#[derive(Clone)]
pub(super) struct Request {
    pub id: String,
    pub questions: Vec<jcode_sdk::QuestionSpec>,
    pub answers: Vec<Option<String>>,
    pub active: usize,
    /// Lazily created the first time the user picks "Other" on a question;
    /// torn down on navigating away so a stray typed draft on one question
    /// never leaks into another's answer.
    pub other_input: Option<Entity<PromptInput>>,
}

impl Request {
    /// Next question still missing an answer, searching forward and
    /// wrapping — mirrors the TUI's `nextUnanswered`. `None` once every
    /// question has one.
    fn next_unanswered(&self, from: usize) -> Option<usize> {
        let total = self.questions.len();
        (1..=total)
            .map(|n| (from + n) % total)
            .find(|&i| self.answers[i].is_none())
    }
}

/// Requests waiting for an answer, oldest first. Unlike permissions, only
/// ever shows one at a time in practice (a turn asks once), but the queue
/// shape is kept the same for the same reason: a second ask must not be
/// silently dropped while the first is still up.
#[derive(Default)]
pub(super) struct PendingQuestions(VecDeque<Request>);

impl PendingQuestions {
    pub(super) fn observe(&mut self, event: &ApiEvent) {
        match event {
            ApiEvent::RuntimeCommandResult { data, .. } => {
                let Some(payload) = jcode_sdk::QuestionPayload::from_data(data) else {
                    return;
                };
                if self.0.iter().any(|r| r.id == payload.request_id) {
                    return;
                }
                let total = payload.questions.len();
                self.0.push_back(Request {
                    id: payload.request_id,
                    questions: payload.questions,
                    answers: vec![None; total],
                    active: 0,
                    other_input: None,
                });
            }
            // A finished or failed turn takes its open asks with it, same as
            // permissions — an unanswered question timing out server-side
            // must not leave a stale card the user can still click.
            ApiEvent::TurnDone { .. } | ApiEvent::TurnStopped { .. } | ApiEvent::Error { .. } => {
                self.0.clear()
            }
            _ => {}
        }
    }

    pub(super) fn front(&self) -> Option<&Request> {
        self.0.front()
    }

    fn find_mut(&mut self, id: &str) -> Option<&mut Request> {
        self.0.iter_mut().find(|r| r.id == id)
    }

    fn take(&mut self, id: &str) {
        self.0.retain(|r| r.id != id);
    }
}

impl Panel {
    pub(super) fn render_question_card(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let request = self.question_requests.front()?.clone();
        let theme = Theme::global();
        let total = request.questions.len();
        let spec = request.questions.get(request.active)?.clone();
        let header = spec.header.clone().unwrap_or_else(|| "Question".into());
        let title = if total > 1 {
            format!("{header} ({}/{total})", request.active + 1)
        } else {
            header
        };

        let mut options = div().flex().flex_col().gap_1();
        for (index, option) in spec.options.iter().enumerate() {
            let request_id = request.id.clone();
            let label = option.label.clone();
            let description = option.description.clone();
            options = options.child(
                div()
                    .id(("question-option", index))
                    .debug_selector(move || format!("question-option-{index}"))
                    .px_3()
                    .py_2()
                    .rounded_md()
                    .cursor_pointer()
                    .bg(theme.TOOL_BG)
                    .hover(|el| el.bg(theme.INPUT_BG))
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(div().text_size(px(13.0)).text_color(theme.TEXT).child(option.label.clone()))
                    .when(!option.description.is_empty(), |el| {
                        el.child(
                            div()
                                .text_size(px(11.0))
                                .text_color(theme.TEXT_DIM)
                                .child(option.description.clone()),
                        )
                    })
                    .on_click(cx.listener(move |panel, _, _, cx| {
                        panel.answer_question_option(&request_id, label.clone(), cx);
                    })),
            );
            let _ = description;
        }

        let other_request_id = request.id.clone();
        options = options.child(if let Some(input) = &request.other_input {
            div()
                .p_2()
                .rounded_md()
                .bg(theme.INPUT_BG)
                .child(input.clone())
                .into_any_element()
        } else {
            div()
                .id("question-other")
                .debug_selector(|| "question-other".into())
                .px_3()
                .py_2()
                .rounded_md()
                .cursor_pointer()
                .bg(theme.TOOL_BG)
                .hover(|el| el.bg(theme.INPUT_BG))
                .text_size(px(13.0))
                .text_color(theme.TEXT_DIM)
                .child("Other — type your own answer")
                .on_click(cx.listener(move |panel, _, window, cx| {
                    panel.start_question_other_answer(&other_request_id, window, cx);
                }))
                .into_any_element()
        });

        let mut card = div()
            .debug_selector(|| "question-card".into())
            .p_3()
            .rounded_xl()
            .bg(theme.PANEL_BG)
            .shadow_lg()
            .occlude()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(title))
                    .child({
                        let request_id = request.id.clone();
                        div()
                            .id("question-skip")
                            .debug_selector(|| "question-skip".into())
                            .text_size(px(11.0))
                            .text_color(theme.TEXT_DIM)
                            .cursor_pointer()
                            .hover(|el| el.text_color(theme.TEXT))
                            .child("skip")
                            .on_click(cx.listener(move |panel, _, _, cx| {
                                panel.reject_question(&request_id, cx);
                            }))
                    }),
            )
            .child(
                div()
                    .text_size(px(13.0))
                    .text_color(theme.TEXT)
                    .child(spec.question.clone()),
            )
            .child(options);

        if total > 1 {
            let prev_id = request.id.clone();
            let next_id = request.id.clone();
            card = card.child(
                div()
                    .flex()
                    .justify_between()
                    .text_size(px(11.0))
                    .text_color(theme.TEXT_DIM)
                    .child(
                        div()
                            .id("question-prev")
                            .debug_selector(|| "question-prev".into())
                            .cursor_pointer()
                            .hover(|el| el.text_color(theme.TEXT))
                            .child("← previous")
                            .on_click(cx.listener(move |panel, _, _, cx| {
                                panel.navigate_question(&prev_id, -1, cx);
                            })),
                    )
                    .child(
                        div()
                            .id("question-next")
                            .debug_selector(|| "question-next".into())
                            .cursor_pointer()
                            .hover(|el| el.text_color(theme.TEXT))
                            .child("next →")
                            .on_click(cx.listener(move |panel, _, _, cx| {
                                panel.navigate_question(&next_id, 1, cx);
                            })),
                    ),
            );
        }

        Some(card.into_any_element())
    }

    /// A preset option was picked. Advances to the next unanswered question,
    /// or — once every question has an answer — sends the reply and closes
    /// the card. Mirrors the TUI's `askAt`/`nextUnanswered` flow.
    fn answer_question_option(&mut self, request_id: &str, label: String, cx: &mut Context<Self>) {
        let Some(request) = self.question_requests.find_mut(request_id) else {
            return;
        };
        let active = request.active;
        request.answers[active] = Some(label);
        request.other_input = None;
        if let Some(next) = request.next_unanswered(active) {
            request.active = next;
            cx.notify();
            return;
        }
        let answers: Vec<String> = request
            .answers
            .iter()
            .map(|a| a.clone().unwrap_or_default())
            .collect();
        self.question_requests.take(request_id);
        self.bridge.send(Command::AnswerQuestion {
            session_id: self.session_id.clone(),
            request_id: request_id.to_string(),
            answers,
        });
        cx.notify();
    }

    /// Opens the inline "Other" field for the active question. Reuses
    /// `PromptInput` the same way the rename dialog does (`workspace_rename.rs`)
    /// rather than hand-rolling key capture for a one-off text field.
    fn start_question_other_answer(
        &mut self,
        request_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(request) = self.question_requests.find_mut(request_id) else {
            return;
        };
        if request.other_input.is_some() {
            return;
        }
        let owner = cx.weak_entity();
        let submit_id = request_id.to_string();
        let input = cx.new(|cx| {
            PromptInput::new(cx, "Type your own answer", move |text, _, _, app| {
                let _ = owner.update(app, |panel, cx| {
                    panel.answer_question_option(&submit_id, text, cx);
                });
            })
            .without_command_completion()
        });
        let focus = input.read(cx).focus_handle.clone();
        window.focus(&focus, cx);
        request.other_input = Some(input);
        cx.notify();
    }

    fn navigate_question(&mut self, request_id: &str, delta: isize, cx: &mut Context<Self>) {
        let Some(request) = self.question_requests.find_mut(request_id) else {
            return;
        };
        let total = request.questions.len() as isize;
        if total <= 1 {
            return;
        }
        request.active = (((request.active as isize + delta) % total) + total) as usize % total as usize;
        request.other_input = None;
        cx.notify();
    }

    /// Declines the whole question request outright (the TUI's Esc).
    fn reject_question(&mut self, request_id: &str, cx: &mut Context<Self>) {
        self.question_requests.take(request_id);
        self.bridge.send(Command::RejectQuestion {
            session_id: self.session_id.clone(),
            request_id: request_id.to_string(),
        });
        cx.notify();
    }
}
