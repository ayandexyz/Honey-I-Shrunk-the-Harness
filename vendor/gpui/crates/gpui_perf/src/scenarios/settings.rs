//! An IDE-like application shell showing a settings page.
//!
//! The window is made of views the way a real application is: a title bar, an
//! activity bar of icons, a navigation tree of collapsible groups, a row of
//! tabs, a settings page of grouped rows (each row its own view, with a
//! toggle, dropdown, number stepper or color swatch), a status bar and a toast
//! drawn over everything with `deferred(anchored(..))`. Every view reads its
//! colors from a [`Theme`] stored as a GPUI global.
//!
//! The scenarios change one part of it per frame: a single setting, the
//! status bar clock, the whole theme, a navigation group, or the toast.

use gpui::{
    Anchor, AnyView, App, Context, Entity, Global, Hsla, IntoElement, Render, SharedString, Window,
    anchored, deferred, div, hsla, point, prelude::*, px,
};

/// The colors every view reads, stored as a global.
#[derive(Clone)]
struct Theme {
    name: SharedString,
    background: Hsla,
    surface: Hsla,
    panel: Hsla,
    border: Hsla,
    text: Hsla,
    muted: Hsla,
    accent: Hsla,
    accent_text: Hsla,
    control: Hsla,
    hover: Hsla,
    warning: Hsla,
}

impl Global for Theme {}

impl Theme {
    /// One of a few deterministic variants: a dark and a light theme whose
    /// accent hue rotates with `index`.
    fn variant(index: usize) -> Self {
        let hue = (index as f32 * 0.137) % 1.0;
        if index.is_multiple_of(2) {
            Theme {
                name: format!("Dark {}", index).into(),
                background: hsla(hue, 0.08, 0.10, 1.),
                surface: hsla(hue, 0.08, 0.13, 1.),
                panel: hsla(hue, 0.08, 0.16, 1.),
                border: hsla(hue, 0.08, 0.24, 1.),
                text: hsla(hue, 0.05, 0.90, 1.),
                muted: hsla(hue, 0.05, 0.60, 1.),
                accent: hsla(hue, 0.65, 0.55, 1.),
                accent_text: hsla(0., 0., 1., 1.),
                control: hsla(hue, 0.08, 0.30, 1.),
                hover: hsla(hue, 0.10, 0.20, 1.),
                warning: hsla(0.1, 0.8, 0.55, 1.),
            }
        } else {
            Theme {
                name: format!("Light {}", index).into(),
                background: hsla(hue, 0.10, 0.97, 1.),
                surface: hsla(hue, 0.10, 0.94, 1.),
                panel: hsla(hue, 0.10, 0.90, 1.),
                border: hsla(hue, 0.10, 0.80, 1.),
                text: hsla(hue, 0.10, 0.12, 1.),
                muted: hsla(hue, 0.08, 0.40, 1.),
                accent: hsla(hue, 0.70, 0.45, 1.),
                accent_text: hsla(0., 0., 1., 1.),
                control: hsla(hue, 0.10, 0.75, 1.),
                hover: hsla(hue, 0.12, 0.86, 1.),
                warning: hsla(0.08, 0.85, 0.45, 1.),
            }
        }
    }
}

/// State shared between the rows and the title bar: how many settings differ
/// from their defaults.
struct SettingsModel {
    modified: usize,
}

// ---------------------------------------------------------------------------
// Title bar

struct TitleBar {
    model: Entity<SettingsModel>,
}

impl Render for TitleBar {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let modified = self.model.read(cx).modified;
        let theme = cx.global::<Theme>();
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .h(px(32.))
            .px_2()
            .bg(theme.surface)
            .border_b_1()
            .border_color(theme.border)
            .text_color(theme.text)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap_2()
                    .items_center()
                    .children(
                        [theme.warning, theme.accent, theme.muted]
                            .into_iter()
                            .map(|color| div().size(px(10.)).rounded_full().bg(color)),
                    )
                    .child(div().child("gpui-fast — Settings")),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap_2()
                    .items_center()
                    .child(div().text_color(theme.muted).child(theme.name.clone()))
                    .child(
                        div()
                            .px_2()
                            .rounded_md()
                            .bg(if modified > 0 {
                                theme.accent
                            } else {
                                theme.control
                            })
                            .text_color(theme.accent_text)
                            .child(format!("{} modified", modified)),
                    ),
            )
    }
}

// ---------------------------------------------------------------------------
// Activity bar

struct ActivityBar {
    selected: usize,
}

const ACTIVITY_ICONS: usize = 9;

impl Render for ActivityBar {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<Theme>();
        let selected = self.selected;
        div()
            .flex()
            .flex_col()
            .items_center()
            .gap_2()
            .py_2()
            .w(px(44.))
            .bg(theme.surface)
            .border_r_1()
            .border_color(theme.border)
            .children((0..ACTIVITY_ICONS).map(|index| {
                let active = index == selected;
                let color = if active { theme.accent } else { theme.muted };
                // A small glyph made of divs: a frame with a few bars inside.
                div()
                    .size(px(30.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_md()
                    .when(active, |this| this.bg(theme.hover))
                    .border_l_2()
                    .border_color(if active { theme.accent } else { theme.surface })
                    .child(
                        div()
                            .size(px(18.))
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .p(px(2.))
                            .border_1()
                            .border_color(color)
                            .rounded_sm()
                            .children((0..(index % 3 + 1)).map(|bar| {
                                div()
                                    .h(px(2.))
                                    .w(px(4. + 3. * ((bar + index) % 3) as f32))
                                    .bg(color)
                            })),
                    )
            }))
    }
}

// ---------------------------------------------------------------------------
// Navigation tree

struct NavGroup {
    title: SharedString,
    items: Vec<SharedString>,
    expanded: bool,
}

struct NavTree {
    groups: Vec<NavGroup>,
    selected: (usize, usize),
}

const NAV_GROUPS: [(&str, &[&str]); 8] = [
    (
        "Editor",
        &[
            "Font",
            "Cursor",
            "Minimap",
            "Wrapping",
            "Indentation",
            "Gutter",
        ],
    ),
    ("Workbench", &["Appearance", "Layout", "Tabs", "Zen mode"]),
    ("Terminal", &["Shell", "Fonts", "Scrollback", "Bell"]),
    ("Languages", &["Rust", "TypeScript", "Python", "Go", "C++"]),
    ("Git", &["Blame", "Gutter", "Diff", "Remotes"]),
    ("Extensions", &["Installed", "Updates", "Recommended"]),
    ("Keymap", &["Vim", "Emacs", "Base", "Custom"]),
    ("Privacy", &["Telemetry", "Crash reports", "Network"]),
];

impl NavTree {
    fn new() -> Self {
        NavTree {
            groups: NAV_GROUPS
                .iter()
                .enumerate()
                .map(|(index, (title, items))| NavGroup {
                    title: (*title).into(),
                    items: items.iter().map(|item| (*item).into()).collect(),
                    expanded: index % 2 == 0,
                })
                .collect(),
            selected: (0, 1),
        }
    }
}

impl Render for NavTree {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<Theme>();
        let selected = self.selected;
        div()
            .flex()
            .flex_col()
            .w(px(200.))
            .p_1()
            .bg(theme.panel)
            .border_r_1()
            .border_color(theme.border)
            .text_color(theme.text)
            .overflow_hidden()
            .child(
                div()
                    .px_1()
                    .pb_1()
                    .text_color(theme.muted)
                    .child("SETTINGS"),
            )
            .children(self.groups.iter().enumerate().map(|(group_index, group)| {
                div()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .gap_1()
                            .px_1()
                            .rounded_sm()
                            .hover(|style| style.bg(theme.hover))
                            .child(
                                div()
                                    .w(px(12.))
                                    .text_color(theme.muted)
                                    .child(if group.expanded { "v" } else { ">" }),
                            )
                            .child(group.title.clone()),
                    )
                    .when(group.expanded, |this| {
                        this.children(group.items.iter().enumerate().map(|(item_index, item)| {
                            let active = selected == (group_index, item_index);
                            div()
                                .flex()
                                .flex_row()
                                .gap_1()
                                .pl(px(20.))
                                .rounded_sm()
                                .when(active, |this| {
                                    this.bg(theme.accent).text_color(theme.accent_text)
                                })
                                .hover(|style| style.bg(theme.hover))
                                .child(div().size(px(6.)).mt(px(6.)).rounded_full().bg(if active {
                                    theme.accent_text
                                } else {
                                    theme.muted
                                }))
                                .child(item.clone())
                        }))
                    })
            }))
    }
}

// ---------------------------------------------------------------------------
// Tabs

struct TabBar {
    tabs: Vec<SharedString>,
    active: usize,
}

impl Render for TabBar {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<Theme>();
        let active = self.active;
        div()
            .flex()
            .flex_row()
            .h(px(30.))
            .bg(theme.surface)
            .border_b_1()
            .border_color(theme.border)
            .children(self.tabs.iter().enumerate().map(|(index, title)| {
                let is_active = index == active;
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .border_r_1()
                    .border_color(theme.border)
                    .when(is_active, |this| {
                        this.bg(theme.background)
                            .border_t_2()
                            .border_color(theme.accent)
                    })
                    .text_color(if is_active { theme.text } else { theme.muted })
                    .hover(|style| style.bg(theme.hover))
                    .child(title.clone())
                    .child(div().text_color(theme.muted).child("x"))
            }))
    }
}

// ---------------------------------------------------------------------------
// Setting rows

#[derive(Clone, Copy, PartialEq)]
enum Control {
    Toggle(bool),
    Dropdown(usize),
    Stepper(i32),
    Color(usize),
}

const DROPDOWN_OPTIONS: [&str; 4] = ["Automatic", "Always", "Never", "On focus"];

const SWATCHES: [(f32, f32, f32); 6] = [
    (0.0, 0.7, 0.55),
    (0.08, 0.8, 0.55),
    (0.16, 0.8, 0.5),
    (0.35, 0.6, 0.45),
    (0.58, 0.7, 0.55),
    (0.78, 0.6, 0.6),
];

impl Control {
    fn next(self) -> Self {
        match self {
            Control::Toggle(on) => Control::Toggle(!on),
            Control::Dropdown(index) => Control::Dropdown((index + 1) % DROPDOWN_OPTIONS.len()),
            Control::Stepper(value) => Control::Stepper(if value >= 24 { 8 } else { value + 1 }),
            Control::Color(index) => Control::Color((index + 1) % SWATCHES.len()),
        }
    }
}

struct SettingRow {
    label: SharedString,
    description: SharedString,
    default: Control,
    value: Control,
    model: Entity<SettingsModel>,
}

impl SettingRow {
    /// Moves the control to its next value and keeps the shared modified
    /// count up to date.
    fn change(&mut self, cx: &mut Context<Self>) {
        let was_modified = self.value != self.default;
        self.value = self.value.next();
        let is_modified = self.value != self.default;
        if was_modified != is_modified {
            self.model.update(cx, |model, cx| {
                if is_modified {
                    model.modified += 1;
                } else {
                    model.modified -= 1;
                }
                cx.notify();
            });
        }
        cx.notify();
    }
}

impl Render for SettingRow {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<Theme>();
        let modified = self.value != self.default;
        let control = match self.value {
            Control::Toggle(on) => div()
                .flex()
                .flex_row()
                .when(on, |this| this.justify_end())
                .w(px(36.))
                .h(px(20.))
                .p(px(2.))
                .rounded_full()
                .bg(if on { theme.accent } else { theme.control })
                .child(div().size(px(16.)).rounded_full().bg(theme.accent_text)),
            Control::Dropdown(index) => div()
                .flex()
                .flex_row()
                .justify_between()
                .items_center()
                .w(px(140.))
                .px_2()
                .rounded_md()
                .border_1()
                .border_color(theme.border)
                .bg(theme.surface)
                .child(DROPDOWN_OPTIONS[index])
                .child(div().text_color(theme.muted).child("v")),
            Control::Stepper(value) => div()
                .flex()
                .flex_row()
                .items_center()
                .rounded_md()
                .border_1()
                .border_color(theme.border)
                .child(
                    div()
                        .px_2()
                        .bg(theme.control)
                        .hover(|style| style.bg(theme.hover))
                        .child("-"),
                )
                .child(
                    div()
                        .w(px(40.))
                        .flex()
                        .justify_center()
                        .child(format!("{}", value)),
                )
                .child(
                    div()
                        .px_2()
                        .bg(theme.control)
                        .hover(|style| style.bg(theme.hover))
                        .child("+"),
                ),
            Control::Color(index) => {
                let (h, s, l) = SWATCHES[index];
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .size(px(20.))
                            .rounded_sm()
                            .border_1()
                            .border_color(theme.border)
                            .bg(hsla(h, s, l, 1.)),
                    )
                    .child(div().text_color(theme.muted).child(format!(
                        "#{:02x}{:02x}{:02x}",
                        index * 40,
                        128,
                        255 - index * 30
                    )))
            }
        };

        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap_4()
            .px_3()
            .py_2()
            .border_b_1()
            .border_color(theme.border)
            .hover(|style| style.bg(theme.hover))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap_2()
                    .child(div().w(px(3.)).rounded_sm().bg(if modified {
                        theme.accent
                    } else {
                        theme.background
                    }))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(div().text_color(theme.text).child(self.label.clone()))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted)
                                    .child(self.description.clone()),
                            ),
                    ),
            )
            .child(control)
    }
}

// ---------------------------------------------------------------------------
// Settings page

struct SettingsGroup {
    title: SharedString,
    rows: Vec<Entity<SettingRow>>,
}

struct SettingsPage {
    groups: Vec<SettingsGroup>,
}

const PAGE_GROUPS: [&str; 8] = [
    "Text editing",
    "Appearance",
    "Files",
    "Search",
    "Terminal",
    "Version control",
    "Language servers",
    "Accessibility",
];

const ROWS_PER_GROUP: usize = 10;

const ROW_WORDS: [&str; 12] = [
    "Format on save",
    "Tab size",
    "Show whitespace",
    "Cursor style",
    "Highlight color",
    "Auto save",
    "Line height",
    "Soft wrap",
    "Inlay hints",
    "Selection color",
    "Scrollbar",
    "Font size",
];

impl SettingsPage {
    fn new(model: &Entity<SettingsModel>, cx: &mut Context<Self>) -> Self {
        let groups = PAGE_GROUPS
            .iter()
            .enumerate()
            .map(|(group_index, title)| SettingsGroup {
                title: (*title).into(),
                rows: (0..ROWS_PER_GROUP)
                    .map(|row_index| {
                        let n = group_index * ROWS_PER_GROUP + row_index;
                        let default = match n % 4 {
                            0 => Control::Toggle(n.is_multiple_of(3)),
                            1 => Control::Dropdown(n % DROPDOWN_OPTIONS.len()),
                            2 => Control::Stepper(8 + (n % 12) as i32),
                            _ => Control::Color(n % SWATCHES.len()),
                        };
                        let model = model.clone();
                        cx.new(|_| SettingRow {
                            label: format!("{} {}", ROW_WORDS[n % ROW_WORDS.len()], n).into(),
                            description: format!(
                                "Controls how {} behaves in {}. Applies to every open workspace.",
                                ROW_WORDS[(n * 7) % ROW_WORDS.len()].to_lowercase(),
                                title.to_lowercase()
                            )
                            .into(),
                            default,
                            value: default,
                            model,
                        })
                    })
                    .collect(),
            })
            .collect();
        SettingsPage { groups }
    }

    fn row(&self, index: usize) -> Entity<SettingRow> {
        let index = index % (self.groups.len() * ROWS_PER_GROUP);
        self.groups[index / ROWS_PER_GROUP].rows[index % ROWS_PER_GROUP].clone()
    }
}

impl Render for SettingsPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<Theme>();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .gap_3()
            .p_3()
            .bg(theme.background)
            .overflow_hidden()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.surface)
                    .text_color(theme.muted)
                    .child("Search settings…"),
            )
            .children(self.groups.iter().map(|group| {
                div()
                    .flex()
                    .flex_col()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.surface)
                    .child(
                        div()
                            .px_3()
                            .py_1()
                            .bg(theme.panel)
                            .text_color(theme.text)
                            .child(group.title.clone()),
                    )
                    .children(group.rows.iter().cloned())
            }))
    }
}

// ---------------------------------------------------------------------------
// Status bar

struct StatusBar {
    tick: usize,
}

impl Render for StatusBar {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<Theme>();
        let tick = self.tick;
        let seconds = 9 * 3600 + tick;
        let clock = format!(
            "{:02}:{:02}:{:02}",
            (seconds / 3600) % 24,
            (seconds / 60) % 60,
            seconds % 60
        );
        let progress = (tick % 100) as f32 / 100.;
        let item = |text: SharedString| {
            div()
                .px_2()
                .hover(|style| style.bg(theme.hover))
                .child(text)
        };
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .h(px(24.))
            .bg(theme.accent)
            .text_color(theme.accent_text)
            .text_xs()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .child(item("master".into()))
                    .child(item("0 errors, 2 warnings".into()))
                    .child(item("rust-analyzer".into())),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .child(
                        div()
                            .w(px(100.))
                            .h(px(6.))
                            .mx_2()
                            .rounded_full()
                            .bg(theme.control)
                            .child(
                                div()
                                    .h_full()
                                    .w(px(100. * progress))
                                    .rounded_full()
                                    .bg(theme.accent_text),
                            ),
                    )
                    .child(item(format!("Indexing {}%", tick % 100).into()))
                    .child(item(
                        format!("Ln {}, Col {}", 1 + tick / 7 % 400, 1 + tick % 80).into(),
                    ))
                    .child(item("UTF-8".into()))
                    .child(item("LF".into()))
                    .child(item(clock.into())),
            )
    }
}

// ---------------------------------------------------------------------------
// Toast

struct Toast {
    visible: bool,
    progress: f32,
}

impl Render for Toast {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<Theme>();
        div().when(self.visible, |this| {
            this.child(
                deferred(
                    anchored()
                        .anchor(Anchor::BottomRight)
                        .position(point(px(1180.), px(760.)))
                        .snap_to_window()
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .w(px(300.))
                                .p_3()
                                .rounded_md()
                                .border_1()
                                .border_color(theme.border)
                                .bg(theme.panel)
                                .text_color(theme.text)
                                .shadow_md()
                                .child(
                                    div()
                                        .flex()
                                        .flex_row()
                                        .justify_between()
                                        .child("Downloading language server")
                                        .child(div().text_color(theme.muted).child("x")),
                                )
                                .child(div().text_xs().text_color(theme.muted).child(format!(
                                    "rust-analyzer 2026-09-28 — {:.0}%",
                                    self.progress * 100.
                                )))
                                .child(
                                    div()
                                        .h(px(4.))
                                        .w_full()
                                        .rounded_full()
                                        .bg(theme.control)
                                        .child(
                                            div()
                                                .h_full()
                                                .w(px(276. * self.progress))
                                                .rounded_full()
                                                .bg(theme.accent),
                                        ),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .flex_row()
                                        .gap_2()
                                        .justify_end()
                                        .child(
                                            div()
                                                .px_2()
                                                .rounded_sm()
                                                .bg(theme.control)
                                                .child("Hide"),
                                        )
                                        .child(
                                            div()
                                                .px_2()
                                                .rounded_sm()
                                                .bg(theme.accent)
                                                .text_color(theme.accent_text)
                                                .child("Cancel"),
                                        ),
                                ),
                        ),
                )
                .with_priority(1),
            )
        })
    }
}

// ---------------------------------------------------------------------------
// The shell

struct Shell {
    title_bar: Entity<TitleBar>,
    activity_bar: Entity<ActivityBar>,
    nav_tree: Entity<NavTree>,
    tabs: Entity<TabBar>,
    page: Entity<SettingsPage>,
    status: Entity<StatusBar>,
    toast: Entity<Toast>,
}

impl Shell {
    fn new(cx: &mut Context<Self>) -> Self {
        let model = cx.new(|_| SettingsModel { modified: 0 });
        let title_bar = cx.new(|_| TitleBar {
            model: model.clone(),
        });
        let page = cx.new(|cx| SettingsPage::new(&model, cx));
        Shell {
            title_bar,
            activity_bar: cx.new(|_| ActivityBar { selected: 3 }),
            nav_tree: cx.new(|_| NavTree::new()),
            tabs: cx.new(|_| TabBar {
                tabs: [
                    "Settings",
                    "main.rs",
                    "Cargo.toml",
                    "keymap.json",
                    "README.md",
                    "window.rs",
                ]
                .into_iter()
                .map(SharedString::from)
                .collect(),
                active: 0,
            }),
            page,
            status: cx.new(|_| StatusBar { tick: 0 }),
            toast: cx.new(|_| Toast {
                visible: false,
                progress: 0.,
            }),
        }
    }
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<Theme>();
        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(theme.background)
            .text_sm()
            .child(self.title_bar.clone())
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .overflow_hidden()
                    .child(self.activity_bar.clone())
                    .child(self.nav_tree.clone())
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .overflow_hidden()
                            .child(self.tabs.clone())
                            .child(self.page.clone()),
                    ),
            )
            .child(self.status.clone())
            .child(self.toast.clone())
    }
}

// ---------------------------------------------------------------------------
// Scenarios

fn build_shell(cx: &mut App) -> AnyView {
    cx.set_global(Theme::variant(0));
    cx.new(Shell::new).into()
}

fn shell(root: &AnyView) -> Entity<Shell> {
    root.clone().downcast::<Shell>().unwrap()
}

fn tick_status(shell: &Entity<Shell>, frame: usize, cx: &mut App) {
    let status = shell.read(cx).status.clone();
    status.update(cx, |status, cx| {
        status.tick = frame;
        cx.notify();
    });
}

#[derive(Clone, Copy)]
enum Kind {
    Toggle,
    StatusTick,
    ThemeSwitch,
    TreeExpand,
    Toast,
}

struct SettingsScenario {
    kind: Kind,
}

impl crate::Scenario for SettingsScenario {
    fn name(&self) -> &'static str {
        match self.kind {
            Kind::Toggle => "settings-toggle",
            Kind::StatusTick => "settings-status-tick",
            Kind::ThemeSwitch => "settings-theme-switch",
            Kind::TreeExpand => "settings-tree-expand",
            Kind::Toast => "settings-toast",
        }
    }

    fn description(&self) -> &'static str {
        match self.kind {
            Kind::Toggle => {
                "An IDE settings screen where one setting row changes each frame and the title bar's modified count follows."
            }
            Kind::StatusTick => {
                "An idle IDE settings screen where only the status bar clock and progress change each frame."
            }
            Kind::ThemeSwitch => {
                "An IDE settings screen whose global theme changes every 10 frames, restyling every view; the status bar ticks between."
            }
            Kind::TreeExpand => {
                "An IDE settings screen where a navigation tree group expands or collapses every 5 frames; the status bar ticks between."
            }
            Kind::Toast => {
                "An IDE settings screen with a deferred, anchored toast that appears, animates its progress bar each frame, and disappears."
            }
        }
    }

    fn build(&self, _window: &mut Window, cx: &mut App) -> AnyView {
        build_shell(cx)
    }

    fn step(&self, root: &AnyView, frame: usize, _window: &mut Window, cx: &mut App) {
        let shell = shell(root);
        match self.kind {
            Kind::Toggle => {
                let page = shell.read(cx).page.clone();
                // Walk the rows with a stride so consecutive frames touch
                // different groups.
                let row = page.read(cx).row(frame * 7);
                row.update(cx, |row, cx| row.change(cx));
            }
            Kind::StatusTick => tick_status(&shell, frame, cx),
            Kind::ThemeSwitch => {
                if frame.is_multiple_of(10) {
                    cx.set_global(Theme::variant(frame / 10));
                } else {
                    tick_status(&shell, frame, cx);
                }
            }
            Kind::TreeExpand => {
                if frame.is_multiple_of(5) {
                    let tree = shell.read(cx).nav_tree.clone();
                    tree.update(cx, |tree, cx| {
                        let index = (frame / 5) % tree.groups.len();
                        tree.groups[index].expanded = !tree.groups[index].expanded;
                        cx.notify();
                    });
                } else {
                    tick_status(&shell, frame, cx);
                }
            }
            Kind::Toast => {
                // A 60-frame cycle: shown for 40 frames while its progress
                // fills, then hidden for 20.
                let phase = frame % 60;
                let visible = phase < 40;
                let toast = shell.read(cx).toast.clone();
                toast.update(cx, |toast, cx| {
                    if visible || toast.visible {
                        toast.visible = visible;
                        toast.progress = if visible { phase as f32 / 39. } else { 0. };
                        cx.notify();
                    }
                });
            }
        }
    }
}

pub fn scenarios() -> Vec<Box<dyn crate::Scenario>> {
    [
        Kind::Toggle,
        Kind::StatusTick,
        Kind::ThemeSwitch,
        Kind::TreeExpand,
        Kind::Toast,
    ]
    .into_iter()
    .map(|kind| Box::new(SettingsScenario { kind }) as Box<dyn crate::Scenario>)
    .collect()
}
