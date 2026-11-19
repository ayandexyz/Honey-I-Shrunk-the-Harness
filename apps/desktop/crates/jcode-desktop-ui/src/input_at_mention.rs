//! The `@` file-mention picker in the prompt composer.
//!
//! Typing `@` opens a list of files under the project's working directory.
//! Picking one replaces the `@…` token under the cursor with the path, so
//! the prompt reads `@src/main.rs` and the agent reads the file with its own
//! tools — nothing is uploaded.
//!
//! The picker is a sibling of the slash-command overlay: it opens in the same
//! place, takes the same arrow/enter keys, and closes when the token under
//! the cursor is no longer a mention.

use super::*;

use crate::at_mention::{self, MentionCandidate};

/// How many rows the picker shows at once.
const LIMIT: usize = 20;

/// The picker state, kept next to the composer's own suggestion state.
pub(super) struct MentionPicker {
    /// Rows for the mention under the cursor.
    pub candidates: Vec<MentionCandidate>,
    /// The highlighted row.
    pub selection: usize,
    /// The token under the cursor, so a completion can replace exactly it.
    pub prefix: String,
    /// Byte offset of the token's start in the composer's content.
    pub start: usize,
    /// Byte offset of the token's end in the composer's content.
    pub end: usize,
}

impl MentionPicker {
    /// Refresh the picker for the text before the cursor.
    ///
    /// Returns `None` when the cursor is not in a mention, which closes the
    /// picker. The working directory is the composer's project: mentions are
    /// project-relative, the way the TUI's are.
    pub(super) fn refresh(
        &mut self,
        text_before_cursor: &str,
        content: &str,
        cursor: usize,
        working_dir: Option<&str>,
    ) -> Option<()> {
        let prefix = at_mention::mention_prefix(text_before_cursor)?.to_string();
        // The token starts at the cursor minus the prefix's bytes.
        let end = cursor;
        let start = end.checked_sub(prefix.len())?;
        let root = working_dir.map(std::path::Path::new)?;
        let candidates = at_mention::mention_candidates(text_before_cursor, Some(root), LIMIT);
        self.candidates = candidates;
        if self.selection >= self.candidates.len() {
            self.selection = 0;
        }
        self.prefix = prefix;
        self.start = start;
        self.end = end;
        Some(())
    }

    /// The highlighted row's text, ready to replace the token with.
    pub(super) fn selected_value(&self) -> Option<&str> {
        self.candidates
            .get(self.selection)
            .map(|candidate| candidate.value.as_str())
    }

    /// The range the token occupies in the composer's content.
    pub(super) fn token_range(&self) -> Range<usize> {
        self.start..self.end
    }
}

/// The text before the caret, for mention detection.
///
/// `cursor` is a byte offset into `content`; it is clamped to the nearest
/// character boundary at or below it.
pub(super) fn text_before_cursor(content: &str, cursor: usize) -> &str {
    let mut end = cursor.min(content.len());
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }
    &content[..end]
}

/// Split the composer's text into runs, coloring `@path` mentions.
///
/// The TUI colors a mention yellow; the desktop uses the theme's accent so
/// the mention stands out without inventing a new color.
pub(super) fn mention_runs(text: &str, run: &TextRun) -> Vec<TextRun> {
    let spans = at_mention::mention_spans(text);
    if spans.is_empty() {
        return vec![run.clone()];
    }
    let mention_color = to_hsla(Theme::global().ACCENT);
    let mut runs = Vec::with_capacity(spans.len() * 2);
    let mut cursor = 0;
    for span in spans {
        if span.start > cursor {
            runs.push(TextRun {
                len: span.start - cursor,
                ..run.clone()
            });
        }
        runs.push(TextRun {
            len: span.end - span.start,
            color: mention_color,
            ..run.clone()
        });
        cursor = span.end;
    }
    if cursor < text.len() {
        runs.push(TextRun {
            len: text.len() - cursor,
            ..run.clone()
        });
    }
    runs
}

impl PromptInput {
    /// Refresh the picker for the current text and caret.
    ///
    /// Called after every edit, so the picker opens and closes with the
    /// mention under the cursor.
    pub(super) fn refresh_mention_picker(&mut self, cx: &mut Context<Self>) {
        let cursor = self.cursor_offset();
        let before = text_before_cursor(&self.content, cursor);
        let working_dir = self.working_dir.clone();
        let content = self.content.clone();
        let refreshed = self.mention_picker.refresh(
            before,
            &content,
            cursor,
            working_dir.as_deref(),
        );
        if refreshed.is_none() {
            self.mention_picker.candidates.clear();
        }
        if self.mention_picker.selection >= self.mention_picker.candidates.len() {
            self.mention_picker.selection = 0;
        }
        let _ = cx;
    }

    /// Whether the picker is open.
    pub(super) fn mention_picker_open(&self) -> bool {
        !self.mention_picker.candidates.is_empty()
    }

    /// Move the picker's selection.
    pub(super) fn move_mention_selection(&mut self, delta: isize, cx: &mut Context<Self>) {
        let count = self.mention_picker.candidates.len();
        if count == 0 {
            return;
        }
        let current = self.mention_picker.selection as isize;
        let next = (current + delta).rem_euclid(count as isize) as usize;
        self.mention_picker.selection = next;
        self.reveal_mention(next);
        cx.notify();
    }

    /// Keep the highlighted row in view.
    fn reveal_mention(&mut self, index: usize) {
        if self.mention_scroll.bounds_for_item(index).is_some() {
            self.mention_scroll.scroll_to_reveal_item(index);
        } else {
            self.mention_scroll.scroll_to(gpui::ListOffset {
                item_ix: index,
                offset_in_item: px(0.),
            });
        }
    }

    /// Replace the mention under the cursor with the selected path.
    ///
    /// Returns the inserted text, so the caller can report it.
    pub(super) fn accept_mention(&mut self, cx: &mut Context<Self>) -> Option<String> {
        if !self.mention_picker_open() {
            return None;
        }
        let value = self.mention_picker.selected_value()?.to_string();
        let range = self.mention_picker.token_range();
        let start = range.start.min(self.content.len());
        let end = range.end.min(self.content.len());
        let mut content = self.content[..start].to_string();
        content.push_str(&value);
        content.push_str(&self.content[end..]);
        self.undo.push(self.content.to_string());
        self.redo.clear();
        self.content = content.into();
        self.selected_range =
            (start + value.len())..(start + value.len());
        self.selection_reversed = false;
        self.marked_range = None;
        self.mention_picker.candidates.clear();
        self.command_selection = 0;
        if let Some(on_change) = &self.on_change {
            on_change(&self.content, cx);
        }
        cx.notify();
        Some(value)
    }

    /// The rows of the picker, or an empty list when it is closed.
    pub(super) fn mention_candidates(&self) -> &[MentionCandidate] {
        &self.mention_picker.candidates
    }

    /// Render one row of the picker.
    pub(super) fn render_mention_row(
        &self,
        index: usize,
        candidate: MentionCandidate,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let selected = index == self.mention_picker.selection;
        let ink = if selected {
            Theme::global().BG
        } else {
            Theme::global().TEXT_DIM
        };
        div()
            .w_full()
            .flex_none()
            .flex()
            .items_center()
            .justify_between()
            .gap_3()
            .px_3()
            .py_1p5()
            .rounded_md()
            .bg(if selected {
                Theme::global().TEXT
            } else {
                Theme::global().HEADER_BG
            })
            .when(!selected, |row| {
                row.hover(|style| style.bg(Theme::global().INPUT_BG))
            })
            .text_size(px(12.0))
            .text_color(ink)
            .cursor_pointer()
            .on_mouse_move(cx.listener(move |this, _, _, cx| {
                if this.mention_picker.selection != index {
                    this.mention_picker.selection = index;
                    cx.notify();
                }
            }))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap_3()
                    .font_family(Theme::global().FONT_MONO)
                    .text_color(ink)
                    .child(div().min_w_0().truncate().child(candidate.label.clone())),
            )
            .child(
                div()
                    .max_w(relative(0.5))
                    .min_w_0()
                    .truncate()
                    .text_color(if selected {
                        ink
                    } else {
                        Theme::global().TEXT_FAINT
                    })
                    .child(candidate.detail.clone()),
            )
            .child(
                div()
                    .w(px(14.0))
                    .flex_none()
                    .text_color(ink)
                    .when(selected, |marker| {
                        marker
                            .debug_selector(|| "mention-selected".into())
                            .child("✓")
                    }),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    window.focus(&this.focus_handle, cx);
                    this.accept_mention(cx);
                }),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    #[test]
    fn text_before_cursor_stops_at_the_caret() {
        assert_eq!(text_before_cursor("hello world", 5), "hello");
        assert_eq!(text_before_cursor("hello world", 11), "hello world");
        assert_eq!(text_before_cursor("hello world", 99), "hello world");
        assert_eq!(text_before_cursor("", 0), "");
    }

    #[test]
    fn the_picker_opens_on_a_mention_and_closes_otherwise() {
        let dir = temp_dir();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "").unwrap();

        let mut picker = MentionPicker {
            candidates: Vec::new(),
            selection: 0,
            prefix: String::new(),
            start: 0,
            end: 0,
        };
        let content = "look at @mai";
        let cursor = content.len();
        assert!(
            picker
                .refresh(
                    text_before_cursor(content, cursor),
                    content,
                    cursor,
                    root.to_str(),
                )
                .is_some()
        );
        assert_eq!(picker.candidates.len(), 1);
        assert_eq!(picker.selected_value(), Some("@src/main.rs"));
        assert_eq!(picker.token_range(), 8..12);

        // A cursor outside a mention closes it.
        assert!(
            picker
                .refresh(
                    text_before_cursor("no mention here", 13),
                    "no mention here",
                    13,
                    root.to_str(),
                )
                .is_none()
        );
    }

    #[test]
    fn a_missing_working_directory_leaves_the_picker_closed() {
        let mut picker = MentionPicker {
            candidates: Vec::new(),
            selection: 0,
            prefix: String::new(),
            start: 0,
            end: 0,
        };
        assert!(
            picker
                .refresh("@mai", "@mai", 4, None)
                .is_none()
        );
    }

    /// A project with two files the query can match.
    fn project() -> tempfile::TempDir {
        let dir = temp_dir();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "").unwrap();
        fs::write(root.join("src/agent.rs"), "").unwrap();
        dir
    }

    #[gpui::test]
    fn typing_at_opens_the_picker_over_the_project_files(cx: &mut gpui::TestAppContext) {
        let dir = project();
        let root = dir.path().to_string_lossy().into_owned();
        let (input, vcx) = cx.add_window_view(|_, cx| {
            let mut input = PromptInput::new(cx, "test", |_, _, _, _| {});
            input.set_working_dir(Some(&root));
            input
        });
        vcx.run_until_parked();

        vcx.update(|window, cx| {
            input.update(cx, |input, cx| {
                input.replace_text_in_range(None, "@", window, cx);
            });
        });
        vcx.run_until_parked();

        let candidates = input.update(vcx, |input, _| input.mention_candidates().to_vec());
        assert!(
            !candidates.is_empty(),
            "a bare @ should offer the project's files"
        );
        assert!(
            candidates.iter().all(|candidate| candidate.value.starts_with('@')),
            "{candidates:?}"
        );
    }

    #[gpui::test]
    fn the_query_filters_the_picker(cx: &mut gpui::TestAppContext) {
        let dir = project();
        let root = dir.path().to_string_lossy().into_owned();
        let (input, vcx) = cx.add_window_view(|_, cx| {
            let mut input = PromptInput::new(cx, "test", |_, _, _, _| {});
            input.set_working_dir(Some(&root));
            input
        });
        vcx.run_until_parked();

        vcx.update(|window, cx| {
            input.update(cx, |input, cx| {
                input.replace_text_in_range(None, "@agent", window, cx);
            });
        });
        vcx.run_until_parked();

        let values = input.update(vcx, |input, _| {
            input
                .mention_candidates()
                .iter()
                .map(|candidate| candidate.value.clone())
                .collect::<Vec<_>>()
        });
        assert_eq!(values, vec!["@src/agent.rs"]);
    }

    #[gpui::test]
    fn the_arrow_keys_move_the_picker_selection_and_wrap(cx: &mut gpui::TestAppContext) {
        let dir = project();
        let root = dir.path().to_string_lossy().into_owned();
        let (input, vcx) = cx.add_window_view(|_, cx| {
            let mut input = PromptInput::new(cx, "test", |_, _, _, _| {});
            input.set_working_dir(Some(&root));
            input
        });
        vcx.run_until_parked();

        vcx.update(|window, cx| {
            input.update(cx, |input, cx| {
                input.replace_text_in_range(None, "@", window, cx);
            });
        });
        vcx.run_until_parked();

        let count = input.update(vcx, |input, _| input.mention_candidates().len());
        assert!(count > 1, "the fixture should offer more than one file");

        // Down once, then back up past the top: the selection wraps.
        let after_down = input.update(vcx, |input, cx| {
            input.move_mention_selection(1, cx);
            input.mention_picker.selection
        });
        assert_eq!(after_down, 1);

        let after_wrap = input.update(vcx, |input, cx| {
            input.move_mention_selection(-2, cx);
            input.mention_picker.selection
        });
        assert_eq!(after_wrap, count - 1);
    }

    #[gpui::test]
    fn enter_replaces_the_mention_with_the_selected_path(cx: &mut gpui::TestAppContext) {
        let dir = project();
        let root = dir.path().to_string_lossy().into_owned();
        let (input, vcx) = cx.add_window_view(|_, cx| {
            let mut input = PromptInput::new(cx, "test", |_, _, _, _| {});
            input.set_working_dir(Some(&root));
            input
        });
        vcx.run_until_parked();

        vcx.update(|window, cx| {
            input.update(cx, |input, cx| {
                input.replace_text_in_range(None, "look at @agent", window, cx);
            });
        });
        vcx.run_until_parked();

        let accepted = input.update(vcx, |input, cx| input.accept_mention(cx));
        assert_eq!(accepted.as_deref(), Some("@src/agent.rs"));

        let content = input.update(vcx, |input, _| input.content.to_string());
        assert_eq!(content, "look at @src/agent.rs");
        let open = input.update(vcx, |input, _| input.mention_picker_open());
        assert!(!open, "the picker closes after a pick");
    }

    #[gpui::test]
    fn escape_closes_the_picker_without_clearing_the_prompt(cx: &mut gpui::TestAppContext) {
        let dir = project();
        let root = dir.path().to_string_lossy().into_owned();
        let (input, vcx) = cx.add_window_view(|_, cx| {
            let mut input = PromptInput::new(cx, "test", |_, _, _, _| {});
            input.set_working_dir(Some(&root));
            input
        });
        vcx.run_until_parked();

        vcx.update(|window, cx| {
            input.update(cx, |input, cx| {
                input.replace_text_in_range(None, "look at @", window, cx);
            });
        });
        vcx.run_until_parked();
        assert!(input.update(vcx, |input, _| input.mention_picker_open()));

        vcx.update(|window, cx| {
            input.update(cx, |input, cx| {
                input.clear(&super::Clear, window, cx);
            });
        });
        vcx.run_until_parked();

        let content = input.update(vcx, |input, _| input.content.to_string());
        assert_eq!(content, "look at @");
        let open = input.update(vcx, |input, _| input.mention_picker_open());
        assert!(!open, "escape closes the picker");
    }

    #[gpui::test]
    fn a_composer_without_a_project_never_opens_the_picker(cx: &mut gpui::TestAppContext) {
        let (input, vcx) =
            cx.add_window_view(|_, cx| PromptInput::new(cx, "test", |_, _, _, _| {}));
        vcx.run_until_parked();

        vcx.update(|window, cx| {
            input.update(cx, |input, cx| {
                input.replace_text_in_range(None, "@", window, cx);
            });
        });
        vcx.run_until_parked();

        let open = input.update(vcx, |input, _| input.mention_picker_open());
        assert!(!open, "no working directory means no file to offer");
    }

    #[gpui::test]
    fn the_picker_paints_its_overlay_over_the_project_files(cx: &mut gpui::TestAppContext) {
        let dir = project();
        let root = dir.path().to_string_lossy().into_owned();
        let (input, vcx) = cx.add_window_view(|_, cx| {
            let mut input = PromptInput::new(cx, "test", |_, _, _, _| {});
            input.set_working_dir(Some(&root));
            input
        });
        vcx.run_until_parked();

        vcx.update(|window, cx| {
            input.update(cx, |input, cx| {
                input.replace_text_in_range(None, "@agent", window, cx);
            });
        });
        vcx.run_until_parked();

        let overlay = vcx.debug_bounds("mention-overlay");
        assert!(
            overlay.is_some(),
            "the picker should paint its overlay when a mention is open"
        );
        assert!(
            vcx.debug_bounds("mention-scroll").is_some(),
            "the picker should paint its scroll area"
        );
    }
}
