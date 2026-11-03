//! "N changed files" summary row + modal diff viewer for one turn.
//!
//! Git status is snapshotted at turn start (`Panel::capture_turn_change_baseline`)
//! and compared against another snapshot at turn end
//! (`Panel::spawn_turn_change_summary`) to find what that turn touched — not
//! which tool ran, so a background `bash` invoking an external formatter is
//! covered too. All git work runs through `git_ops` on the background
//! executor.
use super::*;
use crate::harness;
use jcode_desktop_model::git_status::{self, GitFile};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnChangeSummary {
    pub directory: String,
    pub files: Vec<TurnChangedFile>,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnChangedFile {
    pub path: String,
    /// Porcelain status letter at turn end (e.g. `M`, `A`, `D`, `?`).
    pub code: char,
}

/// The open modal's file list and loaded diffs, keyed by which transcript
/// row (`Item::TurnChanges` index) it belongs to.
pub(crate) struct State {
    pub(crate) item_index: usize,
    pub(crate) selected: Option<String>,
    pub(crate) diffs: HashMap<String, Result<String, String>>,
    /// Holds focus while the modal is open, so Escape reaches it rather than
    /// whatever was focused in the transcript underneath.
    pub(crate) focus_handle: FocusHandle,
    /// Tracked per selected file so switching files resets scroll position.
    pub(crate) scroll: gpui::ScrollHandle,
}

impl Panel {
    /// Snapshot git status for this turn's baseline. Fire-and-forget: a
    /// remote session or one with no working directory never gets a summary.
    pub(super) fn capture_turn_change_baseline(&mut self, cx: &mut Context<Self>) {
        self.turn_change_baseline = None;
        self.turn_change_token += 1;
        let token = self.turn_change_token;
        let Some(directory) = self
            .working_dir
            .clone()
            .filter(|dir| !dir.trim().is_empty())
        else {
            return;
        };
        if harness::remote_host(&self.session_id).is_some() {
            return;
        }
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let status = crate::git_ops::status(&directory)?;
                    let mtimes = crate::git_ops::mtimes(&directory, &status.files);
                    Ok::<_, String>((status, mtimes))
                })
                .await;
            let _ = this.update(cx, |this, _| {
                if this.turn_change_token != token {
                    return;
                }
                if let Ok((status, mtimes)) = result {
                    this.turn_change_baseline = Some((status.files, mtimes));
                }
            });
        })
        .detach();
    }

    /// Compares the baseline against a fresh status; pushes `Item::TurnChanges`
    /// once resolved, unless nothing changed.
    pub(super) fn spawn_turn_change_summary(
        &mut self,
        baseline: (Vec<GitFile>, HashMap<String, std::time::SystemTime>),
        cx: &mut Context<Self>,
    ) {
        let Some(directory) = self
            .working_dir
            .clone()
            .filter(|dir| !dir.trim().is_empty())
        else {
            return;
        };
        if harness::remote_host(&self.session_id).is_some() {
            return;
        }
        let (baseline_files, baseline_mtimes) = baseline;
        let token = self.turn_change_token;
        cx.spawn(async move |this, cx| {
            let directory_for_status = directory.clone();
            let after = cx
                .background_executor()
                .spawn(async move {
                    let status = crate::git_ops::status(&directory_for_status)?;
                    let mtimes = crate::git_ops::mtimes(&directory_for_status, &status.files);
                    Ok::<_, String>((status, mtimes))
                })
                .await;
            let Ok((after, after_mtimes)) = after else { return };
            let changed = changed_files(&baseline_files, &baseline_mtimes, &after.files, &after_mtimes);
            if changed.is_empty() {
                return;
            }
            let directory_for_numstat = directory.clone();
            let counts = cx
                .background_executor()
                .spawn(async move { crate::git_ops::numstat_since_head(&directory_for_numstat) })
                .await
                .unwrap_or((0, 0));
            let _ = this.update(cx, |this, cx| {
                if this.turn_change_token != token {
                    return;
                }
                this.items.push(Item::TurnChanges(TurnChangeSummary {
                    directory,
                    files: changed,
                    additions: counts.0,
                    deletions: counts.1,
                }));
                this.transcript_measurements.dirty = true;
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn open_turn_change_modal(
        &mut self,
        item_index: usize,
        summary: &TurnChangeSummary,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let selected = summary.files.first().cloned();
        let focus_handle = cx.focus_handle();
        window.focus(&focus_handle, cx);
        self.turn_change_modal = Some(turn_change_modal::State {
            item_index,
            selected: selected.as_ref().map(|file| file.path.clone()),
            diffs: HashMap::new(),
            focus_handle,
            scroll: gpui::ScrollHandle::new(),
        });
        if let Some(file) = selected {
            self.load_turn_change_diff(summary.directory.clone(), file, cx);
        }
        cx.notify();
    }

    pub(super) fn close_turn_change_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.turn_change_modal = None;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    fn select_turn_change_file(
        &mut self,
        directory: String,
        file: TurnChangedFile,
        cx: &mut Context<Self>,
    ) {
        let Some(modal) = &mut self.turn_change_modal else {
            return;
        };
        modal.selected = Some(file.path.clone());
        modal.scroll.set_offset(gpui::Point::default());
        let already_loaded = modal.diffs.contains_key(&file.path);
        cx.notify();
        if !already_loaded {
            self.load_turn_change_diff(directory, file, cx);
        }
    }

    fn load_turn_change_diff(&mut self, directory: String, file: TurnChangedFile, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let path = file.path;
            let task_path = path.clone();
            let untracked = file.code == '?';
            let result = cx
                .background_executor()
                .spawn(async move {
                    if untracked {
                        crate::git_ops::untracked_file_diff(&directory, &task_path)
                    } else {
                        crate::git_ops::diff_since_head(&directory, &task_path)
                    }
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if let Some(modal) = &mut this.turn_change_modal {
                    modal.diffs.insert(path, result);
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_turn_change_row(
        &self,
        index: usize,
        summary: &TurnChangeSummary,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = Theme::global();
        let count = summary.files.len();
        div()
            .id(("turn-changes", index))
            .mx_2()
            .my_1()
            .px_2()
            .h(px(24.0))
            .flex()
            .items_center()
            .gap_2()
            .rounded_full()
            .bg(theme.TOOL_BG)
            .cursor_pointer()
            .hover(|el| el.bg(theme.PANEL_BG))
            .child(
                div()
                    .text_size(px(11.0))
                    .text_color(theme.TEXT)
                    .child(format!("{count} changed {}", if count == 1 { "file" } else { "files" })),
            )
            .child(
                div()
                    .flex()
                    .gap_2()
                    .font_family(theme.FONT_MONO)
                    .text_size(px(11.0))
                    .child(div().text_color(theme.OK).child(format!("+{}", summary.additions)))
                    .child(div().text_color(theme.ERROR).child(format!("-{}", summary.deletions))),
            )
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(move |this, _, window, cx| {
                    let Some(Item::TurnChanges(summary)) = this.items.get(index).cloned() else {
                        return;
                    };
                    this.open_turn_change_modal(index, &summary, window, cx);
                }),
            )
            .into_any_element()
    }

    pub(super) fn render_turn_change_modal(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        let modal = self.turn_change_modal.as_ref()?;
        let Some(Item::TurnChanges(summary)) = self.items.get(modal.item_index) else {
            return None;
        };
        let theme = Theme::global();
        let directory = summary.directory.clone();
        let count = summary.files.len();
        let files = div()
            .id("turn-change-files")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .py_1()
            .children(summary.files.iter().map(|file| {
                let selected = modal.selected.as_deref() == Some(file.path.as_str());
                let path = file.path.clone();
                let directory = directory.clone();
                let clicked = file.clone();
                div()
                    .id(format!("turn-change-file-{}", file.path))
                    .px_2()
                    .h(px(24.0))
                    .flex()
                    .items_center()
                    .gap_2()
                    .cursor_pointer()
                    .when(selected, |el| el.bg(theme.ACCENT_DIM))
                    .when(!selected, |el| el.hover(|el| el.bg(theme.TOOL_BG)))
                    .child(
                        div()
                            .flex_none()
                            .w(px(10.0))
                            .text_size(px(9.0))
                            .text_color(theme.TEXT_DIM)
                            .child(file.code.to_string()),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(10.0))
                            .text_color(theme.TEXT)
                            .child(path.clone()),
                    )
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(move |this, _, _, cx| {
                            this.select_turn_change_file(directory.clone(), clicked.clone(), cx);
                        }),
                    )
                    .into_any_element()
            }));
        let selected_path = modal.selected.clone().unwrap_or_default();
        let body: gpui::AnyElement = match modal.selected.as_deref().and_then(|path| modal.diffs.get(path)) {
            None => div()
                .p_2()
                .text_size(px(10.0))
                .text_color(theme.TEXT_DIM)
                .child("Loading diff…")
                .into_any_element(),
            Some(Err(error)) => div()
                .p_2()
                .text_size(px(10.0))
                .text_color(theme.ERROR)
                .child(error.clone())
                .into_any_element(),
            Some(Ok(patch)) if patch.trim().is_empty() => div()
                .p_2()
                .text_size(px(10.0))
                .text_color(theme.TEXT_DIM)
                .child("Empty file.")
                .into_any_element(),
            Some(Ok(patch)) => div()
                .id("turn-change-diff-scroll")
                .size_full()
                .overflow_y_scroll()
                .track_scroll(&modal.scroll)
                .p_2()
                .text_size(px(10.0))
                .child(crate::diff_block::DiffBlock::new(
                    patch,
                    format!("turn-change-{}", modal.item_index),
                ))
                .into_any_element(),
        };
        Some(
            div()
                .id("turn-change-modal-backdrop")
                .debug_selector(|| "turn-change-modal-backdrop".into())
                .track_focus(&modal.focus_handle)
                .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                    if event.keystroke.key == "escape" {
                        this.close_turn_change_modal(window, cx);
                        cx.stop_propagation();
                    }
                }))
                .absolute()
                .inset_0()
                .size_full()
                .flex()
                .flex_col()
                .bg(theme.PANEL_BG)
                .occlude()
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap_3()
                        .px_3()
                        .py_2()
                        .border_b_1()
                        .border_color(theme.PANEL_BORDER)
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
                                        .child("Changes this turn"),
                                )
                                .child(
                                    div()
                                        .truncate()
                                        .text_size(px(10.0))
                                        .text_color(theme.TEXT_DIM)
                                        .child(directory.clone()),
                                ),
                        )
                        .child(
                            div()
                                .id("turn-change-modal-close")
                                .px_2()
                                .py_1()
                                .rounded_full()
                                .cursor_pointer()
                                .text_size(px(11.0))
                                .text_color(theme.TEXT_DIM)
                                .hover(|el| el.bg(theme.TOOL_BG))
                                .child("Close · Esc")
                                .on_mouse_down(
                                    gpui::MouseButton::Left,
                                    cx.listener(|this, _, window, cx| {
                                        this.close_turn_change_modal(window, cx)
                                    }),
                                ),
                        ),
                )
                .child(
                    div()
                        .flex_1()
                        .min_h_0()
                        .flex()
                        .flex_row()
                        .child(
                            div()
                                .flex_none()
                                .w(relative(0.22))
                                .min_w(px(200.0))
                                .max_w(px(320.0))
                                .flex()
                                .flex_col()
                                .m_2()
                                .mr_0()
                                .rounded_xl()
                                .border_1()
                                .border_color(theme.PANEL_BORDER)
                                .bg(theme.TOOL_BG)
                                .overflow_hidden()
                                .child(
                                    div()
                                        .flex_none()
                                        .flex()
                                        .items_center()
                                        .gap_2()
                                        .px_3()
                                        .pt_2()
                                        .pb_1()
                                        .child(
                                            div()
                                                .text_size(px(11.0))
                                                .font_weight(gpui::FontWeight::SEMIBOLD)
                                                .text_color(theme.TEXT)
                                                .child("Files"),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(10.0))
                                                .text_color(theme.TEXT_DIM)
                                                .child(count.to_string()),
                                        ),
                                )
                                .child(files)
                                .child(
                                    div()
                                        .flex_none()
                                        .flex()
                                        .gap_2()
                                        .px_3()
                                        .py_1p5()
                                        .font_family(theme.FONT_MONO)
                                        .text_size(px(10.0))
                                        .child(div().text_color(theme.OK).child(format!("+{}", summary.additions)))
                                        .child(div().text_color(theme.ERROR).child(format!("-{}", summary.deletions))),
                                ),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .flex()
                                .flex_col()
                                .m_2()
                                .rounded_xl()
                                .border_1()
                                .border_color(theme.PANEL_BORDER)
                                .overflow_hidden()
                                .when(!selected_path.is_empty(), |el| {
                                    el.child(
                                        div()
                                            .flex_none()
                                            .px_3()
                                            .py_1p5()
                                            .border_b_1()
                                            .border_color(theme.PANEL_BORDER)
                                            .text_size(px(11.0))
                                            .font_family(theme.FONT_MONO)
                                            .text_color(theme.TEXT)
                                            .child(selected_path.clone()),
                                    )
                                })
                                .child(body),
                        ),
                )
                .into_any_element(),
        )
    }
}

/// Files whose status differs from the baseline, that are new, or — a file
/// already dirty before the turn, status letters unchanged — whose mtime
/// moved, meaning this turn edited it again. Status letters alone miss that
/// last case: a file that was already `M` stays `M` no matter how many more
/// times it's written.
fn changed_files(
    baseline: &[GitFile],
    baseline_mtimes: &HashMap<String, std::time::SystemTime>,
    after: &[GitFile],
    after_mtimes: &HashMap<String, std::time::SystemTime>,
) -> Vec<TurnChangedFile> {
    after
        .iter()
        .filter(|file| match baseline.iter().find(|before| before.path == file.path) {
            None => true,
            Some(before) => {
                before.index != file.index
                    || before.working != file.working
                    || match (baseline_mtimes.get(&file.path), after_mtimes.get(&file.path)) {
                        (Some(before_mtime), Some(after_mtime)) => before_mtime != after_mtime,
                        _ => false,
                    }
            }
        })
        .map(|file| TurnChangedFile {
            path: file.path.clone(),
            code: if git_status::is_staged(file) {
                file.index
            } else {
                file.working
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, index: char, working: char) -> GitFile {
        GitFile {
            path: path.to_owned(),
            index,
            working,
        }
    }

    fn time(seconds: u64) -> std::time::SystemTime {
        std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds)
    }

    #[test]
    fn only_files_whose_status_changed_are_reported() {
        let baseline = vec![file("untouched.rs", ' ', 'M')];
        let after = vec![
            file("untouched.rs", ' ', 'M'),
            file("edited.rs", ' ', 'M'),
            file("new.rs", '?', '?'),
        ];
        let empty = HashMap::new();
        let changed = changed_files(&baseline, &empty, &after, &empty);
        let paths: Vec<_> = changed.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["edited.rs", "new.rs"]);
    }

    #[test]
    fn a_file_reverted_back_to_its_baseline_status_is_not_reported() {
        let baseline = vec![file("a.rs", ' ', 'M')];
        let after = vec![file("a.rs", ' ', 'M')];
        let empty = HashMap::new();
        assert!(changed_files(&baseline, &empty, &after, &empty).is_empty());
    }

    #[test]
    fn staged_status_wins_the_displayed_code_over_working_tree_status() {
        let baseline = vec![];
        let after = vec![file("a.rs", 'M', ' ')];
        let empty = HashMap::new();
        assert_eq!(changed_files(&baseline, &empty, &after, &empty)[0].code, 'M');
    }

    #[test]
    fn a_file_already_dirty_before_the_turn_is_reported_if_edited_again() {
        // Same status letters before and after — the only signal that this
        // turn touched `a.rs` again is its mtime moving.
        let baseline = vec![file("a.rs", ' ', 'M')];
        let after = vec![file("a.rs", ' ', 'M')];
        let before_mtimes = HashMap::from([("a.rs".to_owned(), time(100))]);
        let after_mtimes = HashMap::from([("a.rs".to_owned(), time(200))]);
        let changed = changed_files(&baseline, &before_mtimes, &after, &after_mtimes);
        assert_eq!(changed[0].path, "a.rs");
    }

    #[test]
    fn a_file_already_dirty_before_the_turn_is_not_reported_if_untouched() {
        let baseline = vec![file("a.rs", ' ', 'M')];
        let after = vec![file("a.rs", ' ', 'M')];
        let mtimes = HashMap::from([("a.rs".to_owned(), time(100))]);
        assert!(changed_files(&baseline, &mtimes, &after, &mtimes).is_empty());
    }
}
