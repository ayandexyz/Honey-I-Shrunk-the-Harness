//! Source Control: branch, staged/unstaged changes and a commit box for the
//! active session's project, docked on the right. All git work (status,
//! diff, stage, commit) runs through `git_ops` on the background executor —
//! nothing here touches a filesystem or process directly.
use super::*;
use jcode_desktop_model::git_status::{self, GitFile, GitStatus};

pub(super) const WIDTH: f32 = 300.0;

const REFRESH_ICON: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/></g></svg>"#;

const STATUS_LABELS: &[(char, &str)] = &[
    ('A', "Added"),
    ('M', "Modified"),
    ('T', "Modified"),
    ('D', "Deleted"),
    ('R', "Renamed"),
    ('C', "Copied"),
    ('U', "Conflict"),
    ('?', "Untracked"),
];

fn status_label(code: char) -> &'static str {
    STATUS_LABELS
        .iter()
        .find(|(c, _)| *c == code)
        .map_or("Modified", |(_, label)| *label)
}

#[derive(Default)]
pub(super) struct State {
    directory: Option<String>,
    status: Option<GitStatus>,
    error: Option<String>,
    loading: bool,
    token: usize,
    /// The one file whose diff is shown inline below its row.
    expanded: Option<(String, bool)>,
    diffs: HashMap<(String, bool), Result<String, String>>,
    commit_input: Option<Entity<PromptInput>>,
    committing: bool,
    commit_error: Option<String>,
}

impl State {
    fn staged(&self) -> Vec<GitFile> {
        self.status
            .iter()
            .flat_map(|status| status.files.iter())
            .filter(|file| git_status::is_staged(file))
            .cloned()
            .collect()
    }

    fn unstaged(&self) -> Vec<GitFile> {
        self.status
            .iter()
            .flat_map(|status| status.files.iter())
            .filter(|file| git_status::is_unstaged(file))
            .cloned()
            .collect()
    }
}

impl Workspace {
    pub(super) fn toggle_source_control(
        &mut self,
        _: &ToggleSourceControl,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.show_source_control = !self.show_source_control;
        if self.show_source_control {
            self.refresh_source_control(cx);
        }
        cx.notify();
    }

    fn active_panel_context(&self, cx: &Context<Self>) -> Option<(String, String)> {
        let panel = self.slots.get(self.active)?.panel.read(cx);
        let directory = panel
            .working_dir
            .clone()
            .filter(|directory| !directory.trim().is_empty())?;
        Some((panel.session_id.clone(), directory))
    }

    pub(super) fn refresh_source_control(&mut self, cx: &mut Context<Self>) {
        self.source_control.token += 1;
        self.source_control.diffs.clear();
        self.source_control.expanded = None;
        self.source_control.commit_error = None;
        let Some((session_id, directory)) = self.active_panel_context(cx) else {
            self.source_control.directory = None;
            self.source_control.status = None;
            self.source_control.error = Some("No project is open.".into());
            cx.notify();
            return;
        };
        if harness::remote_host(&session_id).is_some() {
            self.source_control.directory = None;
            self.source_control.status = None;
            self.source_control.error =
                Some("Source Control cannot inspect a remote checkout from this Desktop.".into());
            cx.notify();
            return;
        }
        self.source_control.directory = Some(directory.clone());
        self.source_control.loading = true;
        self.source_control.error = None;
        let token = self.source_control.token;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { crate::git_ops::status(&directory) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.source_control.token != token {
                    return;
                }
                this.source_control.loading = false;
                match result {
                    Ok(status) => this.source_control.status = Some(status),
                    Err(error) => {
                        this.source_control.status = None;
                        this.source_control.error = Some(error);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn toggle_stage(&mut self, path: String, staged: bool, cx: &mut Context<Self>) {
        self.stage_paths(vec![path], staged, cx);
    }

    fn stage_paths(&mut self, paths: Vec<String>, staged: bool, cx: &mut Context<Self>) {
        if paths.is_empty() {
            return;
        }
        let Some(directory) = self.source_control.directory.clone() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { crate::git_ops::stage(&directory, &paths, staged) })
                .await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(()) => this.refresh_source_control(cx),
                Err(error) => {
                    this.source_control.error = Some(error);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn toggle_expanded(&mut self, path: String, staged: bool, code: char, cx: &mut Context<Self>) {
        let key = (path.clone(), staged);
        if self.source_control.expanded.as_ref() == Some(&key) {
            self.source_control.expanded = None;
            cx.notify();
            return;
        }
        self.source_control.expanded = Some(key.clone());
        cx.notify();
        if self.source_control.diffs.contains_key(&key) {
            return;
        }
        let Some(directory) = self.source_control.directory.clone() else {
            return;
        };
        let untracked = code == '?';
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    if untracked {
                        crate::git_ops::untracked_file_diff(&directory, &path)
                    } else {
                        crate::git_ops::diff(&directory, &path, staged)
                    }
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.source_control.diffs.insert(key, result);
                cx.notify();
            });
        })
        .detach();
    }

    fn submit_commit(&mut self, message: &str, cx: &mut Context<Self>) {
        let message = message.trim().to_owned();
        if message.is_empty() || self.source_control.committing {
            return;
        }
        let Some(directory) = self.source_control.directory.clone() else {
            return;
        };
        if self.source_control.staged().is_empty() {
            self.source_control.commit_error = Some("Stage at least one file to commit.".into());
            cx.notify();
            return;
        }
        self.source_control.committing = true;
        self.source_control.commit_error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { crate::git_ops::commit(&directory, &message) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.source_control.committing = false;
                match result {
                    Ok(()) => {
                        if let Some(input) = this.source_control.commit_input.clone() {
                            input.update(cx, |input, cx| input.set_content(String::new(), cx));
                        }
                        this.refresh_source_control(cx);
                    }
                    Err(error) => {
                        this.source_control.commit_error = Some(error);
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    fn ensure_commit_input(&mut self, cx: &mut Context<Self>) -> Entity<PromptInput> {
        if let Some(input) = &self.source_control.commit_input {
            return input.clone();
        }
        let weak = cx.weak_entity();
        let input = cx.new(|cx| {
            PromptInput::new(cx, "Commit message", move |message, _, _, app| {
                let _ = weak.update(app, |this, cx| this.submit_commit(&message, cx));
            })
        });
        self.source_control.commit_input = Some(input.clone());
        input
    }

    fn render_source_control_row(
        &self,
        file: &GitFile,
        staged: bool,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = Theme::global();
        let path = file.path.clone();
        let code = if staged { file.index } else { file.working };
        let expanded = self.source_control.expanded.as_ref() == Some(&(path.clone(), staged));
        let row_path = path.clone();
        let toggle_path = path.clone();
        let stage_path = path.clone();
        div()
            .flex_none()
            .flex()
            .flex_col()
            .child(
                div()
                    .id(format!("sc-file-{staged}-{path}"))
                    .px_2()
                    .h(px(24.0))
                    .flex()
                    .items_center()
                    .gap_2()
                    .rounded_full()
                    .cursor_pointer()
                    .hover(|el| el.bg(theme.TOOL_BG))
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(move |this, _, _, cx| {
                            this.toggle_expanded(toggle_path.clone(), staged, code, cx);
                        }),
                    )
                    .child(
                        div()
                            .flex_none()
                            .w(px(16.0))
                            .text_size(px(9.0))
                            .text_color(theme.TEXT_DIM)
                            .child(status_label(code).chars().next().unwrap_or('?').to_string()),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(11.0))
                            .text_color(theme.TEXT)
                            .child(row_path),
                    )
                    .child(
                        div()
                            .id(format!("sc-stage-{staged}-{path}"))
                            .flex_none()
                            .size(px(18.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_full()
                            .text_size(px(12.0))
                            .text_color(theme.TEXT_DIM)
                            .hover(|el| el.bg(theme.PANEL_BG).text_color(theme.TEXT))
                            .cursor_pointer()
                            .child(if staged { "−" } else { "+" })
                            .on_mouse_down(
                                gpui::MouseButton::Left,
                                cx.listener(move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.toggle_stage(stage_path.clone(), !staged, cx);
                                }),
                            ),
                    ),
            )
            .when(expanded, |el| {
                let body: gpui::AnyElement = match self.source_control.diffs.get(&(path.clone(), staged)) {
                    None => div()
                        .px_2()
                        .py_1()
                        .text_size(px(11.0))
                        .text_color(theme.TEXT_DIM)
                        .child("Loading diff…")
                        .into_any_element(),
                    Some(Err(error)) => div()
                        .px_2()
                        .py_1()
                        .text_size(px(11.0))
                        .text_color(theme.ERROR)
                        .child(error.clone())
                        .into_any_element(),
                    Some(Ok(patch)) if patch.trim().is_empty() => div()
                        .px_2()
                        .py_1()
                        .text_size(px(11.0))
                        .text_color(theme.TEXT_DIM)
                        .child("Empty file.")
                        .into_any_element(),
                    Some(Ok(patch)) => div()
                        .px_2()
                        .pb_1()
                        .child(crate::diff_block::DiffBlock::new(
                            patch,
                            format!("sc-{path}-{staged}"),
                        ))
                        .into_any_element(),
                };
                el.child(body)
            })
            .into_any_element()
    }

    fn render_source_control_section(
        &self,
        title: &'static str,
        files: &[GitFile],
        staged: bool,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        if files.is_empty() {
            return None;
        }
        let theme = Theme::global();
        let paths: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
        let action_label = if staged { "Unstage all" } else { "Stage all" };
        Some(
            div()
                .flex_none()
                .flex()
                .flex_col()
                .child(
                    div()
                        .px_2()
                        .py_1()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(
                            div()
                                .flex_1()
                                .text_size(px(10.0))
                                .font_weight(gpui::FontWeight::SEMIBOLD)
                                .text_color(theme.TEXT_DIM)
                                .child(format!("{title} ({})", files.len())),
                        )
                        .child(
                            div()
                                .id(format!("sc-section-action-{staged}"))
                                .text_size(px(10.0))
                                .text_color(theme.TEXT_DIM)
                                .cursor_pointer()
                                .hover(|el| el.text_color(theme.TEXT))
                                .child(action_label)
                                .on_mouse_down(
                                    gpui::MouseButton::Left,
                                    cx.listener(move |this, _, _, cx| {
                                        this.stage_paths(paths.clone(), !staged, cx);
                                    }),
                                ),
                        ),
                )
                .children(
                    files
                        .iter()
                        .map(|file| self.render_source_control_row(file, staged, cx)),
                )
                .into_any_element(),
        )
    }

    pub(super) fn render_source_control(&mut self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = Theme::global();
        let branch = self
            .source_control
            .status
            .as_ref()
            .and_then(|status| status.branch.clone())
            .unwrap_or_else(|| "No commits yet".into());
        let staged: Vec<GitFile> = self.source_control.staged();
        let unstaged: Vec<GitFile> = self.source_control.unstaged();
        let total_changed = staged.len() + unstaged.len();
        let staged_count = staged.len();
        let input = self.ensure_commit_input(cx);
        let commit_disabled = self.source_control.committing
            || staged_count == 0
            || input.read(cx).content.trim().is_empty();

        div()
            .id("source-control")
            .debug_selector(|| "source-control".into())
            .flex_none()
            .w(px(WIDTH))
            .h_full()
            .flex()
            .flex_col()
            .border_l_1()
            .border_color(theme.PANEL_BORDER)
            .bg(theme.PANEL_BG)
            .child(
                div()
                    .flex_none()
                    .h(px(36.0))
                    .px_2()
                    .flex()
                    .items_center()
                    .gap_2()
                    .border_b_1()
                    .border_color(theme.PANEL_BORDER)
                    .child(sidebar_worktrees::icon(sidebar_worktrees::BRANCH_ICON, 12.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(12.0))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(theme.TEXT)
                            .child(branch),
                    )
                    .child(
                        div()
                            .id("source-control-refresh")
                            .flex_none()
                            .size(px(20.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_full()
                            .cursor_pointer()
                            .hover(|el| el.bg(theme.TOOL_BG))
                            .child(sidebar_worktrees::icon(REFRESH_ICON, 12.0))
                            .on_mouse_down(
                                gpui::MouseButton::Left,
                                cx.listener(|this, _, _, cx| this.refresh_source_control(cx)),
                            ),
                    ),
            )
            .child(
                div()
                    .id("source-control-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .py_1()
                    .when(self.source_control.loading, |el| {
                        el.child(
                            div()
                                .px_2()
                                .py_2()
                                .text_size(px(11.0))
                                .text_color(theme.TEXT_DIM)
                                .child("Loading changes…"),
                        )
                    })
                    .when_some(self.source_control.error.clone(), |el, error| {
                        el.child(
                            div()
                                .px_2()
                                .py_2()
                                .text_size(px(11.0))
                                .text_color(theme.ERROR)
                                .child(error),
                        )
                    })
                    .when(
                        !self.source_control.loading
                            && self.source_control.error.is_none()
                            && total_changed == 0,
                        |el| {
                            el.child(
                                div()
                                    .px_2()
                                    .py_2()
                                    .text_size(px(11.0))
                                    .text_color(theme.TEXT_DIM)
                                    .child("Working tree clean."),
                            )
                        },
                    )
                    .children(self.render_source_control_section("Staged Changes", &staged, true, cx))
                    .children(self.render_source_control_section("Changes", &unstaged, false, cx)),
            )
            .child(
                div()
                    .flex_none()
                    .p_2()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .border_t_1()
                    .border_color(theme.PANEL_BORDER)
                    .child(input)
                    .children(self.source_control.commit_error.clone().map(|error| {
                        div()
                            .text_size(px(10.0))
                            .text_color(theme.ERROR)
                            .child(error)
                    }))
                    .child(
                        div()
                            .id("source-control-commit")
                            .h(px(26.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_full()
                            .text_size(px(11.0))
                            .text_color(if commit_disabled {
                                theme.TEXT_DIM
                            } else {
                                theme.TEXT
                            })
                            .bg(theme.TOOL_BG)
                            .when(!commit_disabled, |el| {
                                el.cursor_pointer().hover(|el| el.bg(theme.ACCENT_DIM))
                            })
                            .child(if self.source_control.committing {
                                "Committing…"
                            } else {
                                "Commit"
                            })
                            .when(!commit_disabled, |el| {
                                el.on_mouse_down(
                                    gpui::MouseButton::Left,
                                    cx.listener(|this, _, _, cx| {
                                        let message =
                                            this.source_control.commit_input.as_ref().map(|input| {
                                                input.read(cx).content.to_string()
                                            });
                                        if let Some(message) = message {
                                            this.submit_commit(&message, cx);
                                        }
                                    }),
                                )
                            }),
                    ),
            )
            .into_any_element()
    }
}
