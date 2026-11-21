//! List screens: a mail or chat client with a folder sidebar, a toolbar, a
//! long list of messages and a preview pane showing the selected one.
//!
//! The messages live in one model entity, [`MailStore`], which the sidebar,
//! the list and the preview pane all read. The toolbar holds the search text
//! and only reads its own state. Each scenario changes one thing per frame the
//! way a user or live data would: scrolling, moving the selection, messages
//! arriving, or typing into the search box.

use std::rc::Rc;

use gpui::{
    AnyView, App, Context, Entity, FontWeight, Hsla, ListAlignment, ListState, Render,
    ScrollStrategy, SharedString, UniformListScrollHandle, Window, div, hsla, list, point,
    prelude::*, px, uniform_list,
};

use crate::Scenario;

/// Height of a row in the uniform list.
const UNIFORM_ROW_HEIGHT: f32 = 56.;

const FIRST_NAMES: [&str; 16] = [
    "Ada",
    "Grace",
    "Linus",
    "Margaret",
    "Dennis",
    "Barbara",
    "Ken",
    "Frances",
    "Alan",
    "Radia",
    "Bjarne",
    "Hedy",
    "Guido",
    "Katherine",
    "Tim",
    "Sophie",
];

const LAST_NAMES: [&str; 12] = [
    "Lovelace",
    "Hopper",
    "Torvalds",
    "Hamilton",
    "Ritchie",
    "Liskov",
    "Thompson",
    "Allen",
    "Turing",
    "Perlman",
    "Stroustrup",
    "Wilson",
];

const SUBJECTS: [&str; 14] = [
    "Quarterly planning notes",
    "Re: build is failing on main",
    "Lunch on Thursday?",
    "Design review: new onboarding flow",
    "Your invoice is ready",
    "Fwd: conference travel itinerary",
    "Release checklist for v2.4",
    "Question about the scroll performance",
    "Weekly digest",
    "Re: Re: offsite agenda",
    "Security advisory for a dependency",
    "Can you take a look at this PR",
    "Photos from the weekend",
    "Meeting moved to 3pm",
];

const PREVIEW_WORDS: [&str; 24] = [
    "the", "layout", "frame", "we", "should", "measure", "before", "shipping", "retained", "views",
    "scroll", "list", "row", "renders", "again", "only", "when", "its", "data", "changes",
    "please", "review", "thanks", "tomorrow",
];

const TAGS: [&str; 6] = [
    "work",
    "personal",
    "urgent",
    "finance",
    "travel",
    "follow-up",
];

const FOLDERS: [&str; 7] = [
    "Inbox", "Starred", "Snoozed", "Sent", "Drafts", "Archive", "Spam",
];

const CHIPS: [&str; 4] = ["All", "Unread", "Flagged", "Attachments"];

fn color(hue: f32, saturation: f32, lightness: f32) -> Hsla {
    hsla(hue / 360., saturation, lightness, 1.)
}

fn text_color() -> Hsla {
    color(220., 0.15, 0.15)
}

fn muted_color() -> Hsla {
    color(220., 0.08, 0.45)
}

fn border_color() -> Hsla {
    color(220., 0.15, 0.88)
}

fn accent_color() -> Hsla {
    color(215., 0.85, 0.52)
}

fn selected_bg() -> Hsla {
    color(215., 0.9, 0.93)
}

fn hover_bg() -> Hsla {
    color(220., 0.2, 0.96)
}

/// One message.
#[derive(Clone)]
struct MailItem {
    id: usize,
    sender: SharedString,
    initials: SharedString,
    avatar_hue: f32,
    subject: SharedString,
    preview: SharedString,
    timestamp: SharedString,
    tags: Vec<SharedString>,
    folder: usize,
    unread: bool,
    flagged: bool,
    thread_count: usize,
}

fn words(seed: usize, count: usize) -> String {
    let mut text = String::new();
    for i in 0..count {
        if i > 0 {
            text.push(' ');
        }
        let word = PREVIEW_WORDS[(seed.wrapping_mul(31) + i * 7 + i * i) % PREVIEW_WORDS.len()];
        text.push_str(word);
    }
    text.push('.');
    text
}

fn timestamp(minutes_ago: usize) -> SharedString {
    if minutes_ago < 24 * 60 {
        let minute_of_day = (24 * 60 - minutes_ago % (24 * 60)) % (24 * 60);
        format!("{:02}:{:02}", minute_of_day / 60, minute_of_day % 60).into()
    } else {
        let days = minutes_ago / (24 * 60);
        let month = 12 - (days / 30) % 12;
        let day = 28 - days % 28;
        format!("{month}/{day}").into()
    }
}

impl MailItem {
    fn generate(ix: usize) -> Self {
        let first = FIRST_NAMES[ix % FIRST_NAMES.len()];
        let last = LAST_NAMES[(ix / 3 + ix * 7) % LAST_NAMES.len()];
        let sender: SharedString = format!("{first} {last}").into();
        let initials: SharedString = format!(
            "{}{}",
            first.chars().next().unwrap(),
            last.chars().next().unwrap()
        )
        .into();
        let subject = SUBJECTS[(ix * 5 + ix / 7) % SUBJECTS.len()];
        let subject: SharedString = if ix.is_multiple_of(4) {
            format!("{subject} (#{ix})").into()
        } else {
            subject.into()
        };
        // Previews vary a lot in length: some fit on a line, some wrap to
        // several when shown in full.
        let preview_words = 6 + (ix * 13) % 5 * (4 + ix % 9);
        let preview = words(ix, preview_words).into();
        let tag_count = (ix * 7) % 4;
        let tags = (0..tag_count)
            .map(|t| SharedString::from(TAGS[(ix + t * 5) % TAGS.len()]))
            .collect();
        Self {
            id: ix,
            sender,
            initials,
            avatar_hue: ((ix * 47) % 360) as f32,
            subject,
            preview,
            timestamp: timestamp(ix * 17 + ix % 13),
            tags,
            folder: if ix.is_multiple_of(5) {
                (ix / 5) % FOLDERS.len()
            } else {
                0
            },
            unread: ix.is_multiple_of(3) || ix.is_multiple_of(7),
            flagged: ix.is_multiple_of(11),
            thread_count: if ix.is_multiple_of(6) { 2 + ix % 5 } else { 1 },
        }
    }
}

/// The model every view reads its messages from.
struct MailStore {
    items: Vec<MailItem>,
    folder_counts: Vec<(usize, usize)>,
}

impl MailStore {
    fn new(count: usize) -> Self {
        let items: Vec<MailItem> = (0..count).map(MailItem::generate).collect();
        let mut store = Self {
            items,
            folder_counts: Vec::new(),
        };
        store.recount();
        store
    }

    /// Recomputes (total, unread) per folder, as an app does after a change.
    fn recount(&mut self) {
        let mut counts = vec![(0, 0); FOLDERS.len()];
        for item in &self.items {
            counts[item.folder].0 += 1;
            if item.unread {
                counts[item.folder].1 += 1;
            }
        }
        self.folder_counts = counts;
    }

    /// Indices of the items matching `query`, case-insensitively, in the
    /// subject or the sender.
    fn filter(&self, query: &str) -> Vec<usize> {
        if query.is_empty() {
            return (0..self.items.len()).collect();
        }
        let query = query.to_lowercase();
        self.items
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                item.subject.to_lowercase().contains(&query)
                    || item.sender.to_lowercase().contains(&query)
            })
            .map(|(ix, _)| ix)
            .collect()
    }
}

struct Sidebar {
    store: Entity<MailStore>,
    selected_folder: usize,
}

impl Render for Sidebar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let counts = self.store.read(cx).folder_counts.clone();
        div()
            .flex()
            .flex_col()
            .w(px(200.))
            .h_full()
            .flex_none()
            .p_2()
            .gap_1()
            .bg(color(220., 0.2, 0.97))
            .border_r_1()
            .border_color(border_color())
            .child(
                div()
                    .px_2()
                    .py_1()
                    .text_sm()
                    .font_weight(FontWeight::BOLD)
                    .text_color(text_color())
                    .child("Mailboxes"),
            )
            .children(FOLDERS.iter().enumerate().map(|(ix, name)| {
                let (total, unread) = counts[ix];
                let selected = ix == self.selected_folder;
                div()
                    .id(("folder", ix))
                    .flex()
                    .items_center()
                    .justify_between()
                    .px_2()
                    .py_1()
                    .rounded_md()
                    .text_sm()
                    .text_color(text_color())
                    .when(selected, |d| d.bg(selected_bg()))
                    .when(!selected, |d| d.hover(|s| s.bg(hover_bg())))
                    .child(div().child(*name))
                    .child(
                        div()
                            .flex()
                            .gap_1()
                            .text_xs()
                            .when(unread > 0, |d| {
                                d.child(
                                    div()
                                        .px_1()
                                        .rounded_md()
                                        .bg(accent_color())
                                        .text_color(color(0., 0., 1.))
                                        .child(SharedString::from(unread.to_string())),
                                )
                            })
                            .child(
                                div()
                                    .text_color(muted_color())
                                    .child(SharedString::from(total.to_string())),
                            ),
                    )
            }))
    }
}

struct Toolbar {
    query: String,
    active_chip: usize,
    sort_newest_first: bool,
}

impl Render for Toolbar {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let query = if self.query.is_empty() {
            div().text_color(muted_color()).child("Search mail")
        } else {
            div()
                .text_color(text_color())
                .child(SharedString::from(self.query.clone()))
        };
        div()
            .flex()
            .items_center()
            .gap_2()
            .h(px(44.))
            .px_3()
            .border_b_1()
            .border_color(border_color())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .w(px(260.))
                    .h(px(28.))
                    .px_2()
                    .rounded_md()
                    .border_1()
                    .border_color(border_color())
                    .text_sm()
                    .child(div().text_color(muted_color()).child("⌕"))
                    .child(query)
                    .child(div().w(px(1.)).h(px(16.)).bg(accent_color())),
            )
            .children(CHIPS.iter().enumerate().map(|(ix, chip)| {
                let active = ix == self.active_chip;
                div()
                    .id(("chip", ix))
                    .px_2()
                    .py_0p5()
                    .rounded_full()
                    .text_xs()
                    .border_1()
                    .border_color(border_color())
                    .when(active, |d| {
                        d.bg(accent_color()).text_color(color(0., 0., 1.))
                    })
                    .when(!active, |d| {
                        d.text_color(text_color()).hover(|s| s.bg(hover_bg()))
                    })
                    .child(*chip)
            }))
            .child(div().flex_1())
            .child(
                div()
                    .id("sort")
                    .px_2()
                    .py_1()
                    .rounded_md()
                    .text_sm()
                    .text_color(text_color())
                    .hover(|s| s.bg(hover_bg()))
                    .child(if self.sort_newest_first {
                        "Newest first ▾"
                    } else {
                        "Oldest first ▾"
                    }),
            )
    }
}

/// Which container the message list is drawn with.
#[derive(Clone, Copy, PartialEq)]
enum ListKind {
    /// `uniform_list`, every row one line tall with the preview truncated.
    Uniform,
    /// `list`, rows as tall as their wrapped preview.
    Variable,
}

struct MailList {
    store: Entity<MailStore>,
    kind: ListKind,
    /// Indices into the store's items of the rows shown, in order.
    visible: Rc<Vec<usize>>,
    /// The selected row, as an index into `visible`.
    selected: Option<usize>,
    uniform_scroll: UniformListScrollHandle,
    list_state: ListState,
}

impl MailList {
    fn new(store: Entity<MailStore>, kind: ListKind, cx: &App) -> Self {
        let visible = Rc::new((0..store.read(cx).items.len()).collect::<Vec<_>>());
        let list_state = ListState::new(visible.len(), ListAlignment::Top, px(200.));
        Self {
            store,
            kind,
            visible,
            selected: Some(0),
            uniform_scroll: UniformListScrollHandle::new(),
            list_state,
        }
    }

    fn set_query(&mut self, query: &str, cx: &mut Context<Self>) {
        self.visible = Rc::new(self.store.read(cx).filter(query));
        self.selected = if self.visible.is_empty() {
            None
        } else {
            Some(0)
        };
        self.list_state.reset(self.visible.len());
        cx.notify();
    }
}

fn render_row(item: &MailItem, selected: bool, kind: ListKind) -> gpui::AnyElement {
    let avatar = div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(36.))
        .rounded_full()
        .bg(color(item.avatar_hue, 0.55, 0.55))
        .text_color(color(0., 0., 1.))
        .text_sm()
        .font_weight(FontWeight::BOLD)
        .child(item.initials.clone());

    let header = div()
        .flex()
        .items_center()
        .gap_2()
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_sm()
                .text_color(text_color())
                .when(item.unread, |d| d.font_weight(FontWeight::BOLD))
                .child(item.sender.clone()),
        )
        .when(item.thread_count > 1, |d| {
            d.child(
                div()
                    .text_xs()
                    .text_color(muted_color())
                    .child(SharedString::from(item.thread_count.to_string())),
            )
        })
        .when(item.flagged, |d| {
            d.child(div().text_xs().text_color(color(25., 0.9, 0.5)).child("⚑"))
        })
        .child(
            div()
                .flex_none()
                .text_xs()
                .text_color(if item.unread {
                    accent_color()
                } else {
                    muted_color()
                })
                .child(item.timestamp.clone()),
        );

    let subject = div()
        .flex()
        .items_center()
        .gap_1()
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_sm()
                .text_color(text_color())
                .child(item.subject.clone()),
        )
        .children(item.tags.iter().map(|tag| {
            div()
                .flex_none()
                .px_1()
                .rounded_sm()
                .bg(color(150., 0.4, 0.9))
                .text_xs()
                .text_color(color(150., 0.5, 0.3))
                .child(tag.clone())
        }));

    let preview = div()
        .text_xs()
        .text_color(muted_color())
        .child(item.preview.clone());
    let preview = match kind {
        ListKind::Uniform => preview.truncate(),
        ListKind::Variable => preview,
    };

    let row_div = div()
        .id(("mail", item.id))
        .flex()
        .gap_3()
        .px_3()
        .py_2()
        .w_full()
        .border_b_1()
        .border_color(border_color())
        .cursor_pointer()
        .when(selected, |d| d.bg(selected_bg()))
        .when(!selected, |d| d.hover(|s| s.bg(hover_bg())))
        .child(
            div()
                .flex()
                .flex_none()
                .w(px(8.))
                .pt_3()
                .when(item.unread, |d| {
                    d.child(div().size(px(8.)).rounded_full().bg(accent_color()))
                }),
        )
        .child(avatar)
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .gap_0p5()
                .child(header)
                .child(subject)
                .child(preview),
        );
    let row_div = match kind {
        ListKind::Uniform => row_div.h(px(UNIFORM_ROW_HEIGHT)).overflow_hidden(),
        ListKind::Variable => row_div,
    };
    row_div.into_any_element()
}

impl Render for MailList {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let store = self.store.clone();
        let visible = self.visible.clone();
        let selected = self.selected;
        let kind = self.kind;
        let container = match kind {
            ListKind::Uniform => uniform_list("mail-list", visible.len(), move |range, _, cx| {
                let store = store.read(cx);
                range
                    .map(|row| {
                        let item = &store.items[visible[row]];
                        render_row(item, selected == Some(row), kind)
                    })
                    .collect()
            })
            .track_scroll(&self.uniform_scroll)
            .size_full()
            .into_any_element(),
            ListKind::Variable => list(self.list_state.clone(), move |row, _, cx| {
                let store = store.read(cx);
                let item = &store.items[visible[row]];
                render_row(item, selected == Some(row), kind)
            })
            .size_full()
            .into_any_element(),
        };
        div()
            .flex()
            .flex_col()
            .w(px(420.))
            .h_full()
            .flex_none()
            .border_r_1()
            .border_color(border_color())
            .child(
                div()
                    .flex()
                    .justify_between()
                    .px_3()
                    .py_1()
                    .text_xs()
                    .text_color(muted_color())
                    .border_b_1()
                    .border_color(border_color())
                    .child("Inbox")
                    .child(SharedString::from(format!(
                        "{} conversations",
                        self.visible.len()
                    ))),
            )
            .child(div().flex_1().min_h_0().child(container))
    }
}

struct DetailPane {
    store: Entity<MailStore>,
    /// Index into the store's items of the message shown.
    item: Option<usize>,
}

impl Render for DetailPane {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let pane = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .h_full()
            .p_4()
            .gap_3()
            .text_color(text_color());
        let Some(item) = self.item.and_then(|ix| self.store.read(cx).items.get(ix)) else {
            return pane.child(
                div()
                    .text_sm()
                    .text_color(muted_color())
                    .child("No conversation selected"),
            );
        };
        let body = (0..4)
            .map(|p| SharedString::from(words(item.id * 3 + p, 30 + (item.id + p * 11) % 40)))
            .collect::<Vec<_>>();
        pane.child(
            div()
                .text_lg()
                .font_weight(FontWeight::BOLD)
                .child(item.subject.clone()),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap_3()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(40.))
                        .rounded_full()
                        .bg(color(item.avatar_hue, 0.55, 0.55))
                        .text_color(color(0., 0., 1.))
                        .child(item.initials.clone()),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .child(div().text_sm().child(item.sender.clone()))
                        .child(
                            div()
                                .text_xs()
                                .text_color(muted_color())
                                .child(item.timestamp.clone()),
                        ),
                )
                .child(div().flex_1())
                .children(item.tags.iter().map(|tag| {
                    div()
                        .px_2()
                        .rounded_full()
                        .bg(color(150., 0.4, 0.9))
                        .text_xs()
                        .child(tag.clone())
                })),
        )
        .child(
            div()
                .flex()
                .gap_2()
                .children(["Reply", "Reply all", "Forward", "Archive"].map(|label| {
                    div()
                        .id(label)
                        .px_2()
                        .py_1()
                        .rounded_md()
                        .border_1()
                        .border_color(border_color())
                        .text_sm()
                        .hover(|s| s.bg(hover_bg()))
                        .child(label)
                })),
        )
        .child(div().h(px(1.)).bg(border_color()))
        .child(div().text_sm().child(item.preview.clone()))
        .children(body.into_iter().map(|p| div().text_sm().child(p)))
    }
}

/// The whole screen.
pub struct MailScreen {
    store: Entity<MailStore>,
    sidebar: Entity<Sidebar>,
    toolbar: Entity<Toolbar>,
    list: Entity<MailList>,
    detail: Entity<DetailPane>,
}

impl MailScreen {
    fn new(count: usize, kind: ListKind, cx: &mut Context<Self>) -> Self {
        let store = cx.new(|_| MailStore::new(count));
        let sidebar = cx.new(|_| Sidebar {
            store: store.clone(),
            selected_folder: 0,
        });
        let toolbar = cx.new(|_| Toolbar {
            query: String::new(),
            active_chip: 0,
            sort_newest_first: true,
        });
        let list = cx.new(|cx| MailList::new(store.clone(), kind, cx));
        let detail = cx.new(|_| DetailPane {
            store: store.clone(),
            item: Some(0),
        });
        Self {
            store,
            sidebar,
            toolbar,
            list,
            detail,
        }
    }
}

/// Moves the selection to `row` of the list, scrolls it into view and shows
/// it in the preview pane, as the down arrow key does.
fn select_row(list: &Entity<MailList>, detail: &Entity<DetailPane>, row: usize, cx: &mut App) {
    let item = list.update(cx, |list, cx| {
        let row = row.min(list.visible.len().saturating_sub(1));
        list.selected = Some(row);
        match list.kind {
            ListKind::Uniform => list
                .uniform_scroll
                .scroll_to_item(row, ScrollStrategy::Nearest),
            ListKind::Variable => list.list_state.scroll_to_reveal_item(row),
        }
        cx.notify();
        list.visible.get(row).copied()
    });
    detail.update(cx, |detail, cx| {
        detail.item = item;
        cx.notify();
    });
}

impl Render for MailScreen {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .size_full()
            .bg(color(0., 0., 1.))
            .text_color(text_color())
            .child(self.sidebar.clone())
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .child(self.toolbar.clone())
                    .child(
                        div()
                            .flex()
                            .flex_1()
                            .min_h_0()
                            .child(self.list.clone())
                            .child(self.detail.clone()),
                    ),
            )
    }
}

fn screen(root: &AnyView) -> Entity<MailScreen> {
    root.clone().downcast::<MailScreen>().unwrap()
}

fn build_screen(count: usize, kind: ListKind, window: &mut Window, cx: &mut App) -> AnyView {
    let _ = window;
    cx.new(|cx| MailScreen::new(count, kind, cx)).into()
}

/// `uniform_list` of 100,000 rows scrolled a fixed distance each frame.
struct UniformScroll;

impl Scenario for UniformScroll {
    fn name(&self) -> &'static str {
        "list-uniform-scroll"
    }

    fn description(&self) -> &'static str {
        "A mail screen whose 100,000-row uniform_list scrolls 12px per frame, as a wheel does"
    }

    fn build(&self, window: &mut Window, cx: &mut App) -> AnyView {
        build_screen(100_000, ListKind::Uniform, window, cx)
    }

    fn step(&self, root: &AnyView, frame: usize, _window: &mut Window, cx: &mut App) {
        let list = screen(root).read(cx).list.clone();
        list.update(cx, |list, cx| {
            let top = px(frame as f32 * 12.);
            list.uniform_scroll
                .0
                .borrow()
                .base_handle
                .set_offset(point(px(0.), -top));
            cx.notify();
        });
    }
}

/// `list` of 5,000 rows of varying height scrolled each frame.
struct VariableScroll;

impl Scenario for VariableScroll {
    fn name(&self) -> &'static str {
        "list-variable-scroll"
    }

    fn description(&self) -> &'static str {
        "A mail screen whose 5,000-row list of wrapped, varying-height previews scrolls 12px per frame"
    }

    fn build(&self, window: &mut Window, cx: &mut App) -> AnyView {
        build_screen(5_000, ListKind::Variable, window, cx)
    }

    fn step(&self, root: &AnyView, frame: usize, _window: &mut Window, cx: &mut App) {
        if frame == 0 {
            return;
        }
        let list = screen(root).read(cx).list.clone();
        list.update(cx, |list, cx| {
            list.list_state.scroll_by(px(12.));
            cx.notify();
        });
    }
}

/// The selection moves down one row per frame.
struct Select;

impl Scenario for Select {
    fn name(&self) -> &'static str {
        "list-select"
    }

    fn description(&self) -> &'static str {
        "The selection in a 100,000-row mail list moves down one row per frame, updating the preview pane"
    }

    fn build(&self, window: &mut Window, cx: &mut App) -> AnyView {
        build_screen(100_000, ListKind::Uniform, window, cx)
    }

    fn step(&self, root: &AnyView, frame: usize, _window: &mut Window, cx: &mut App) {
        let (list, detail) = {
            let screen = screen(root);
            let screen = screen.read(cx);
            (screen.list.clone(), screen.detail.clone())
        };
        select_row(&list, &detail, frame, cx);
    }
}

/// A few visible rows change each frame, as messages arrive.
struct LiveUpdates;

/// The row the live-updates list is scrolled to.
const LIVE_TOP_ROW: usize = 400;

impl Scenario for LiveUpdates {
    fn name(&self) -> &'static str {
        "list-live-updates"
    }

    fn description(&self) -> &'static str {
        "A still mail list where three visible messages change each frame and the folder counts follow"
    }

    fn build(&self, window: &mut Window, cx: &mut App) -> AnyView {
        let root = build_screen(100_000, ListKind::Uniform, window, cx);
        let list = screen(&root).read(cx).list.clone();
        list.update(cx, |list, _| {
            list.uniform_scroll
                .0
                .borrow()
                .base_handle
                .set_offset(point(px(0.), -px(LIVE_TOP_ROW as f32 * UNIFORM_ROW_HEIGHT)));
        });
        root
    }

    fn step(&self, root: &AnyView, frame: usize, _window: &mut Window, cx: &mut App) {
        let store = screen(root).read(cx).store.clone();
        store.update(cx, |store, cx| {
            for k in 0..3 {
                // Rows within the first dozen in view.
                let ix = LIVE_TOP_ROW + (frame * 5 + k * 4) % 12;
                let item = &mut store.items[ix];
                item.unread = !item.unread;
                item.thread_count += 1;
                item.timestamp = timestamp(frame % (24 * 60));
                item.preview = format!(
                    "New reply #{}: {}",
                    item.thread_count,
                    words(frame + k, 8 + (frame + k) % 12)
                )
                .into();
            }
            store.recount();
            cx.notify();
        });
    }
}

/// A character is typed into the search box every ten frames.
struct Filter;

const FILTER_TEXT: &str = "design review";

impl Scenario for Filter {
    fn name(&self) -> &'static str {
        "list-filter"
    }

    fn description(&self) -> &'static str {
        "Every tenth frame a character is typed into the search box, filtering a 5,000-row varying-height list"
    }

    fn build(&self, window: &mut Window, cx: &mut App) -> AnyView {
        build_screen(5_000, ListKind::Variable, window, cx)
    }

    fn step(&self, root: &AnyView, frame: usize, _window: &mut Window, cx: &mut App) {
        if frame % 10 != 9 {
            return;
        }
        // Type the query, then clear it and start again.
        let cycle = FILTER_TEXT.len() + 1;
        let typed = (frame / 10) % cycle;
        let query = &FILTER_TEXT[..typed];
        let screen = screen(root);
        let screen = screen.read(cx);
        let (toolbar, list, detail) = (
            screen.toolbar.clone(),
            screen.list.clone(),
            screen.detail.clone(),
        );
        toolbar.update(cx, |toolbar, cx| {
            toolbar.query = query.to_string();
            cx.notify();
        });
        let first = list.update(cx, |list, cx| {
            list.set_query(query, cx);
            list.visible.first().copied()
        });
        detail.update(cx, |detail, cx| {
            detail.item = first;
            cx.notify();
        });
    }
}

pub fn scenarios() -> Vec<Box<dyn crate::Scenario>> {
    vec![
        Box::new(UniformScroll),
        Box::new(VariableScroll),
        Box::new(Select),
        Box::new(LiveUpdates),
        Box::new(Filter),
    ]
}
