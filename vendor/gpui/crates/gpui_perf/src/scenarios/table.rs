//! A trading dashboard: a data table of quotes with live prices.
//!
//! The screen is built like a real application would build it. A
//! [`MarketModel`] entity holds the rows' data. Every row is its own view
//! ([`RowView`]) holding a copy of its quote, so a price tick notifies just
//! that row. Around the body sit a toolbar, a sticky header with sortable
//! columns, a footer whose aggregates read the whole model, and a side panel
//! showing the selected row. The body positions the rows and paints the
//! striping and the selection itself, so sorting moves rows without
//! changing them.
//!
//! One layout draws ~200 rows in a plain scrolling div; the other draws
//! 10,000 rows through a `uniform_list`.

use std::ops::Range;

use gpui::{
    AnyView, App, Context, Entity, FontWeight, Hsla, IntoElement, Pixels, Render, SharedString,
    UniformListScrollHandle, Window, div, point, prelude::*, px, rgb, uniform_list,
};

pub fn scenarios() -> Vec<Box<dyn crate::Scenario>> {
    vec![
        Box::new(TableScenario {
            name: "table-ticks-few",
            description: "A 200-row quote table where ~2% of the rows get a new price each frame and the footer aggregates update.",
            kind: Kind::TicksFew,
        }),
        Box::new(TableScenario {
            name: "table-ticks-many",
            description: "A 200-row quote table where half of the rows get a new price each frame and the footer aggregates update.",
            kind: Kind::TicksMany,
        }),
        Box::new(TableScenario {
            name: "table-sort",
            description: "A 200-row quote table re-sorted by a different column every 15 frames, with one price ticking in between.",
            kind: Kind::Sort,
        }),
        Box::new(TableScenario {
            name: "table-virtual-scroll",
            description: "A 10,000-row quote table in a uniform_list that scrolls every frame while a few visible rows tick.",
            kind: Kind::VirtualScroll,
        }),
    ]
}

const SMALL_ROW_COUNT: usize = 200;
const VIRTUAL_ROW_COUNT: usize = 10_000;
const ROW_HEIGHT: Pixels = px(26.);
const HISTORY_LEN: usize = 16;
const SELECTED_ROW: usize = 3;
/// How far the virtual table scrolls each frame.
const SCROLL_STEP: f32 = 37.;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    TicksFew,
    TicksMany,
    Sort,
    VirtualScroll,
}

struct TableScenario {
    name: &'static str,
    description: &'static str,
    kind: Kind,
}

impl crate::Scenario for TableScenario {
    fn name(&self) -> &'static str {
        self.name
    }

    fn description(&self) -> &'static str {
        self.description
    }

    fn build(&self, _window: &mut Window, cx: &mut App) -> AnyView {
        let row_count = if self.kind == Kind::VirtualScroll {
            VIRTUAL_ROW_COUNT
        } else {
            SMALL_ROW_COUNT
        };
        let virtualized = self.kind == Kind::VirtualScroll;
        cx.new(|cx| TableScreen::new(row_count, virtualized, cx))
            .into()
    }

    fn step(&self, root: &AnyView, frame: usize, _window: &mut Window, cx: &mut App) {
        let screen = root.clone().downcast::<TableScreen>().unwrap();
        let screen = screen.read(cx);
        let model = screen.model.clone();
        let rows = screen.rows.clone();
        let header = screen.header.clone();
        let body = screen.body.clone();
        let row_count = rows.len();

        match self.kind {
            Kind::TicksFew => {
                let count = (row_count / 50).max(1);
                let ids: Vec<usize> = (0..count)
                    .map(|k| (frame * 7 + k * 53) % row_count)
                    .collect();
                tick(&model, &rows, &ids, frame, cx);
            }
            Kind::TicksMany => {
                let ids: Vec<usize> = (0..row_count)
                    .filter(|i| (i + frame).is_multiple_of(2))
                    .collect();
                tick(&model, &rows, &ids, frame, cx);
            }
            Kind::Sort => {
                if frame % 15 == 14 {
                    let round = frame / 15;
                    let column = SORTABLE[round % SORTABLE.len()];
                    let ascending = (round / SORTABLE.len()) % 2 == 1;
                    let sort = SortState { column, ascending };
                    let order = sorted_order(model.read(cx), sort);
                    header.update(cx, |header, cx| {
                        header.sort = sort;
                        cx.notify();
                    });
                    body.update(cx, |body, cx| {
                        body.order = order;
                        cx.notify();
                    });
                } else {
                    let ids = [(frame * 13) % row_count];
                    tick(&model, &rows, &ids, frame, cx);
                }
            }
            Kind::VirtualScroll => {
                let max_scroll = (row_count as f32 - 40.) * f32::from(ROW_HEIGHT);
                let offset = (frame as f32 * SCROLL_STEP) % max_scroll;
                let top_row = (offset / f32::from(ROW_HEIGHT)) as usize;
                body.update(cx, |body, cx| {
                    body.scroll_handle
                        .0
                        .borrow()
                        .base_handle
                        .set_offset(point(px(0.), px(-offset)));
                    cx.notify();
                });
                // A few rows in view tick, and a few far away.
                let ids: Vec<usize> = (0..4)
                    .map(|k| (top_row + 2 + k * 7 + frame % 3) % row_count)
                    .chain((0..4).map(|k| (frame * 101 + k * 2503) % row_count))
                    .collect();
                tick(&model, &rows, &ids, frame, cx);
            }
        }
    }
}

/// Gives the rows `ids` a new price for `frame`, in the model and in their
/// row views, and notifies the model once so the aggregates update.
fn tick(
    model: &Entity<MarketModel>,
    rows: &[Entity<RowView>],
    ids: &[usize],
    frame: usize,
    cx: &mut App,
) {
    let quotes: Vec<Quote> = model.update(cx, |model, cx| {
        let quotes = ids
            .iter()
            .map(|&id| {
                let quote = &mut model.quotes[id];
                quote.tick(frame);
                quote.clone()
            })
            .collect();
        cx.notify();
        quotes
    });
    for quote in quotes {
        rows[quote.id].update(cx, |row, cx| {
            row.quote = quote;
            cx.notify();
        });
    }
}

// ---------------------------------------------------------------------------
// Data

#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Open,
    PreMarket,
    Halted,
}

#[derive(Clone)]
struct Quote {
    id: usize,
    symbol: SharedString,
    name: SharedString,
    prev_close: f64,
    price: f64,
    volume: u64,
    history: [f32; HISTORY_LEN],
    status: Status,
}

const NAME_FIRST: [&str; 12] = [
    "Global", "United", "Pacific", "Northern", "Advanced", "First", "Silver", "Blue", "Quantum",
    "Summit", "Harbor", "Crystal",
];
const NAME_SECOND: [&str; 10] = [
    "Energy",
    "Semiconductor",
    "Logistics",
    "Biotech",
    "Holdings",
    "Networks",
    "Materials",
    "Robotics",
    "Foods",
    "Capital",
];
const NAME_SUFFIX: [&str; 5] = ["Inc.", "Corp.", "Ltd.", "Group", "plc"];

impl Quote {
    fn new(id: usize) -> Self {
        let mut code = id * 7919 + 17;
        let mut symbol = String::new();
        for _ in 0..(3 + id % 2) {
            symbol.push((b'A' + (code % 26) as u8) as char);
            code /= 26;
        }
        let name = format!(
            "{} {} {}",
            NAME_FIRST[id % NAME_FIRST.len()],
            NAME_SECOND[(id / 3) % NAME_SECOND.len()],
            NAME_SUFFIX[(id / 7) % NAME_SUFFIX.len()]
        );
        let prev_close = 10. + ((id * 37) % 490) as f64 + ((id * 13) % 100) as f64 / 100.;
        let status = if id % 37 == 5 {
            Status::Halted
        } else if id % 11 == 3 {
            Status::PreMarket
        } else {
            Status::Open
        };
        let mut quote = Self {
            id,
            symbol: symbol.into(),
            name: name.into(),
            prev_close,
            price: prev_close,
            volume: 100_000 + ((id * 7_331) % 9_000_000) as u64,
            history: [0.; HISTORY_LEN],
            status,
        };
        for step in 0..HISTORY_LEN {
            quote.tick(step);
        }
        quote
    }

    /// Moves the price to where it is at `frame`.
    fn tick(&mut self, frame: usize) {
        let phase = frame as f64 * 0.37 + self.id as f64 * 1.3;
        let drift = ((self.id % 9) as f64 - 4.) * 0.004;
        self.price = self.prev_close * (1. + drift + 0.04 * phase.sin());
        self.volume += 100 + ((self.id * 31 + frame * 17) % 500) as u64;
        self.history.rotate_left(1);
        self.history[HISTORY_LEN - 1] = self.price as f32;
    }

    fn change(&self) -> f64 {
        self.price - self.prev_close
    }

    fn change_percent(&self) -> f64 {
        self.change() / self.prev_close * 100.
    }

    fn change_color(&self) -> Hsla {
        if self.change() >= 0. {
            rgb(0x16a34a).into()
        } else {
            rgb(0xdc2626).into()
        }
    }
}

/// Where the quotes live.
struct MarketModel {
    quotes: Vec<Quote>,
}

// ---------------------------------------------------------------------------
// Columns and sorting

#[derive(Clone, Copy, PartialEq, Eq)]
enum Column {
    Symbol,
    Name,
    Price,
    Change,
    ChangeBar,
    Volume,
    Trend,
    Status,
    Actions,
}

const COLUMNS: [(Column, &str, f32); 9] = [
    (Column::Symbol, "Symbol", 72.),
    (Column::Name, "Name", 210.),
    (Column::Price, "Price", 80.),
    (Column::Change, "Change", 110.),
    (Column::ChangeBar, "% Move", 90.),
    (Column::Volume, "Volume", 90.),
    (Column::Trend, "Trend", 80.),
    (Column::Status, "Status", 80.),
    (Column::Actions, "", 110.),
];

const SORTABLE: [Column; 5] = [
    Column::Price,
    Column::Change,
    Column::Volume,
    Column::Name,
    Column::Symbol,
];

#[derive(Clone, Copy, PartialEq, Eq)]
struct SortState {
    column: Column,
    ascending: bool,
}

fn sorted_order(model: &MarketModel, sort: SortState) -> Vec<usize> {
    let quotes = &model.quotes;
    let mut order: Vec<usize> = (0..quotes.len()).collect();
    order.sort_by(|&a, &b| {
        let (a, b) = (&quotes[a], &quotes[b]);
        let ordering = match sort.column {
            Column::Symbol => a.symbol.cmp(&b.symbol),
            Column::Name => a.name.cmp(&b.name),
            Column::Price => a.price.total_cmp(&b.price),
            Column::Change | Column::ChangeBar => a.change_percent().total_cmp(&b.change_percent()),
            Column::Volume => a.volume.cmp(&b.volume),
            _ => std::cmp::Ordering::Equal,
        }
        .then(a.id.cmp(&b.id));
        if sort.ascending {
            ordering
        } else {
            ordering.reverse()
        }
    });
    order
}

fn format_volume(volume: u64) -> String {
    if volume >= 1_000_000 {
        format!("{:.2}M", volume as f64 / 1_000_000.)
    } else {
        format!("{:.1}K", volume as f64 / 1_000.)
    }
}

fn cell(width: f32) -> gpui::Div {
    div()
        .flex_shrink_0()
        .w(px(width))
        .px_1()
        .overflow_hidden()
        .whitespace_nowrap()
}

fn sparkline(history: &[f32; HISTORY_LEN], bar_width: f32, height: f32, color: Hsla) -> gpui::Div {
    let low = history.iter().copied().fold(f32::MAX, f32::min);
    let high = history.iter().copied().fold(f32::MIN, f32::max);
    let span = (high - low).max(0.0001);
    div()
        .flex()
        .flex_row()
        .items_end()
        .gap(px(1.))
        .h(px(height))
        .children(history.iter().map(|&value| {
            let fraction = (value - low) / span;
            div()
                .w(px(bar_width))
                .h(px(2. + fraction * (height - 2.)))
                .bg(color)
        }))
}

// ---------------------------------------------------------------------------
// Views

/// The whole screen. Its render only arranges the child views, so it is
/// drawn again only when it is notified itself.
struct TableScreen {
    model: Entity<MarketModel>,
    rows: Vec<Entity<RowView>>,
    toolbar: Entity<ToolbarView>,
    header: Entity<HeaderView>,
    body: Entity<BodyView>,
    footer: Entity<FooterView>,
    detail: Entity<DetailView>,
}

impl TableScreen {
    fn new(row_count: usize, virtualized: bool, cx: &mut Context<Self>) -> Self {
        let quotes: Vec<Quote> = (0..row_count).map(Quote::new).collect();
        let rows: Vec<Entity<RowView>> = quotes
            .iter()
            .map(|quote| {
                let quote = quote.clone();
                cx.new(|_| RowView { quote })
            })
            .collect();
        let model = cx.new(|_| MarketModel { quotes });
        let toolbar = cx.new(|_| ToolbarView {
            row_count,
            search: "semi".into(),
            visible_columns: [true, true, true, true, true, true, true, false, true],
        });
        let header = cx.new(|_| HeaderView {
            sort: SortState {
                column: Column::Symbol,
                ascending: true,
            },
        });
        let detail = cx.new(|_| DetailView {
            row: rows[SELECTED_ROW].clone(),
        });
        let body = cx.new(|_| BodyView {
            rows: rows.clone(),
            order: (0..row_count).collect(),
            selected: SELECTED_ROW,
            virtualized,
            scroll_handle: UniformListScrollHandle::new(),
            detail: detail.clone(),
        });
        let footer = cx.new(|_| FooterView {
            model: model.clone(),
        });
        Self {
            model,
            rows,
            toolbar,
            header,
            body,
            footer,
            detail,
        }
    }
}

impl Render for TableScreen {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(0xffffff))
            .text_color(rgb(0x1f2937))
            .text_sm()
            .child(self.toolbar.clone())
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .min_h_0()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .border_r_1()
                            .border_color(rgb(0xe5e7eb))
                            .child(self.header.clone())
                            .child(div().flex_1().min_h_0().child(self.body.clone()))
                            .child(self.footer.clone()),
                    )
                    .child(self.detail.clone()),
            )
    }
}

struct ToolbarView {
    row_count: usize,
    search: SharedString,
    visible_columns: [bool; 9],
}

impl Render for ToolbarView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap_3()
            .px_4()
            .py_2()
            .border_b_1()
            .border_color(rgb(0xe5e7eb))
            .bg(rgb(0xf9fafb))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::BOLD)
                            .child("Market Watch"),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(rgb(0x6b7280))
                            .child(format!("{} instruments · live", self.row_count)),
                    ),
            )
            .child(
                div()
                    .id("search")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .w(px(220.))
                    .px_2()
                    .py_1()
                    .rounded_md()
                    .border_1()
                    .border_color(rgb(0xd1d5db))
                    .bg(rgb(0xffffff))
                    .hover(|style| style.border_color(rgb(0x3b82f6)))
                    .child(div().text_color(rgb(0x9ca3af)).child("Search:"))
                    .child(self.search.clone()),
            )
            .child(div().flex_1())
            .children(COLUMNS.iter().zip(self.visible_columns).filter_map(
                |((column, title, _), visible)| {
                    if title.is_empty() {
                        return None;
                    }
                    let id = COLUMNS
                        .iter()
                        .position(|(c, _, _)| c == column)
                        .unwrap_or(0);
                    Some(
                        div()
                            .id(("column-toggle", id))
                            .px_2()
                            .py_0p5()
                            .rounded_md()
                            .text_xs()
                            .border_1()
                            .when(visible, |this| {
                                this.bg(rgb(0xdbeafe))
                                    .border_color(rgb(0x93c5fd))
                                    .text_color(rgb(0x1d4ed8))
                            })
                            .when(!visible, |this| {
                                this.border_color(rgb(0xd1d5db)).text_color(rgb(0x6b7280))
                            })
                            .hover(|style| style.bg(rgb(0xeff6ff)))
                            .child(*title),
                    )
                },
            ))
    }
}

struct HeaderView {
    sort: SortState,
}

impl Render for HeaderView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let sort = self.sort;
        div()
            .flex()
            .flex_row()
            .flex_shrink_0()
            .px_2()
            .py_1()
            .bg(rgb(0xf3f4f6))
            .border_b_1()
            .border_color(rgb(0xe5e7eb))
            .text_xs()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(rgb(0x4b5563))
            .children(
                COLUMNS
                    .iter()
                    .enumerate()
                    .map(|(ix, (column, title, width))| {
                        let active = sort.column == *column;
                        let sortable = SORTABLE.contains(column);
                        cell(*width)
                            .id(("header", ix))
                            .flex()
                            .flex_row()
                            .gap_1()
                            .when(sortable, |this| {
                                this.cursor_pointer()
                                    .hover(|style| style.text_color(rgb(0x111827)))
                            })
                            .child(title.to_uppercase())
                            .when(active, |this| {
                                this.text_color(rgb(0x2563eb)).child(if sort.ascending {
                                    "▲"
                                } else {
                                    "▼"
                                })
                            })
                    }),
            )
    }
}

/// One row's cells. The row does not know its position: striping and
/// selection are painted by the body around it.
struct RowView {
    quote: Quote,
}

impl Render for RowView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let quote = &self.quote;
        let color = quote.change_color();
        let percent = quote.change_percent();
        let bar_width = (percent.abs().min(5.) / 5. * 40.) as f32;
        let (status_label, status_bg, status_fg) = match quote.status {
            Status::Open => ("OPEN", rgb(0xdcfce7), rgb(0x166534)),
            Status::PreMarket => ("PRE", rgb(0xfef3c7), rgb(0x92400e)),
            Status::Halted => ("HALTED", rgb(0xfee2e2), rgb(0x991b1b)),
        };
        let id = quote.id;

        div()
            .flex()
            .flex_row()
            .items_center()
            .size_full()
            .px_2()
            .child(
                cell(COLUMNS[0].2)
                    .font_weight(FontWeight::BOLD)
                    .child(quote.symbol.clone()),
            )
            .child(
                cell(COLUMNS[1].2)
                    .text_ellipsis()
                    .text_color(rgb(0x4b5563))
                    .child(quote.name.clone()),
            )
            .child(cell(COLUMNS[2].2).child(format!("{:.2}", quote.price)))
            .child(cell(COLUMNS[3].2).text_color(color).child(format!(
                "{:+.2} ({:+.2}%)",
                quote.change(),
                percent
            )))
            .child(
                cell(COLUMNS[4].2).child(
                    div()
                        .flex()
                        .flex_row()
                        .w(px(80.))
                        .h(px(8.))
                        .rounded_sm()
                        .bg(rgb(0xf3f4f6))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .justify_end()
                                .w(px(40.))
                                .when(percent < 0., |this| {
                                    this.child(div().w(px(bar_width)).h_full().bg(color))
                                }),
                        )
                        .child(div().w(px(1.)).h_full().bg(rgb(0x9ca3af)))
                        .when(percent >= 0., |this| {
                            this.child(div().w(px(bar_width)).h_full().bg(color))
                        }),
                ),
            )
            .child(
                cell(COLUMNS[5].2)
                    .text_color(rgb(0x6b7280))
                    .child(format_volume(quote.volume)),
            )
            .child(cell(COLUMNS[6].2).child(sparkline(&quote.history, 3., 16., color)))
            .child(
                cell(COLUMNS[7].2).child(
                    div()
                        .px_1()
                        .rounded_sm()
                        .text_xs()
                        .bg(status_bg)
                        .text_color(status_fg)
                        .child(status_label),
                ),
            )
            .child(
                cell(COLUMNS[8].2)
                    .flex()
                    .flex_row()
                    .gap_1()
                    .child(
                        div()
                            .id(("buy", id))
                            .px_2()
                            .rounded_sm()
                            .text_xs()
                            .bg(rgb(0x16a34a))
                            .text_color(rgb(0xffffff))
                            .cursor_pointer()
                            .hover(|style| style.bg(rgb(0x15803d)))
                            .child("Buy"),
                    )
                    .child(
                        div()
                            .id(("sell", id))
                            .px_2()
                            .rounded_sm()
                            .text_xs()
                            .bg(rgb(0xdc2626))
                            .text_color(rgb(0xffffff))
                            .cursor_pointer()
                            .hover(|style| style.bg(rgb(0xb91c1c)))
                            .child("Sell"),
                    ),
            )
    }
}

/// Lays the rows out in sorted order, with striping and the selection.
struct BodyView {
    rows: Vec<Entity<RowView>>,
    /// Row ids in display order.
    order: Vec<usize>,
    selected: usize,
    virtualized: bool,
    scroll_handle: UniformListScrollHandle,
    detail: Entity<DetailView>,
}

impl BodyView {
    fn render_row(&self, position: usize, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        let id = self.order[position];
        let selected = id == self.selected;
        div()
            .id(("row", id))
            .h(ROW_HEIGHT)
            .w_full()
            .border_b_1()
            .border_color(rgb(0xf3f4f6))
            .when(selected, |this| this.bg(rgb(0xdbeafe)))
            .when(!selected && position % 2 == 1, |this| {
                this.bg(rgb(0xf9fafb))
            })
            .when(!selected, |this| {
                this.hover(|style| style.bg(rgb(0xf1f5f9)))
            })
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected = id;
                let row = this.rows[id].clone();
                this.detail.update(cx, |detail, cx| {
                    detail.row = row;
                    cx.notify();
                });
                cx.notify();
            }))
            .child(self.rows[id].clone())
    }
}

impl Render for BodyView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.virtualized {
            div().size_full().child(
                uniform_list(
                    "quotes",
                    self.order.len(),
                    cx.processor(|this, range: Range<usize>, _window, cx| {
                        range
                            .map(|position| this.render_row(position, cx))
                            .collect()
                    }),
                )
                .size_full()
                .track_scroll(&self.scroll_handle),
            )
        } else {
            div().size_full().child(
                div()
                    .id("quotes")
                    .size_full()
                    .overflow_y_scroll()
                    .children((0..self.order.len()).map(|position| self.render_row(position, cx))),
            )
        }
    }
}

/// Aggregates over every quote; reads the model, so it is drawn again
/// whenever any price moves.
struct FooterView {
    model: Entity<MarketModel>,
}

impl Render for FooterView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let quotes = &self.model.read(cx).quotes;
        let count = quotes.len().max(1) as f64;
        let total_volume: u64 = quotes.iter().map(|q| q.volume).sum();
        let notional: f64 = quotes.iter().map(|q| q.price * q.volume as f64).sum();
        let average_price = quotes.iter().map(|q| q.price).sum::<f64>() / count;
        let average_change = quotes.iter().map(|q| q.change_percent()).sum::<f64>() / count;
        let advancers = quotes.iter().filter(|q| q.change() > 0.).count();
        let decliners = quotes.iter().filter(|q| q.change() < 0.).count();
        let halted = quotes.iter().filter(|q| q.status == Status::Halted).count();

        let stat = |label: &'static str, value: String| {
            div()
                .flex()
                .flex_col()
                .child(div().text_xs().text_color(rgb(0x6b7280)).child(label))
                .child(div().font_weight(FontWeight::SEMIBOLD).child(value))
        };
        let change_color: Hsla = if average_change >= 0. {
            rgb(0x16a34a).into()
        } else {
            rgb(0xdc2626).into()
        };

        div()
            .flex()
            .flex_row()
            .flex_shrink_0()
            .gap_6()
            .px_4()
            .py_2()
            .border_t_1()
            .border_color(rgb(0xe5e7eb))
            .bg(rgb(0xf9fafb))
            .child(stat("Rows", quotes.len().to_string()))
            .child(stat("Total volume", format_volume(total_volume)))
            .child(stat("Notional", format!("${:.1}M", notional / 1_000_000.)))
            .child(stat("Avg price", format!("{average_price:.2}")))
            .child(stat("Avg change", format!("{average_change:+.3}%")).text_color(change_color))
            .child(stat("Adv / Dec", format!("{advancers} / {decliners}")))
            .child(stat("Halted", halted.to_string()))
    }
}

/// The selected row in detail; reads that row's view.
struct DetailView {
    row: Entity<RowView>,
}

impl Render for DetailView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let quote = &self.row.read(cx).quote;
        let color = quote.change_color();
        let low = quote.history.iter().copied().fold(f32::MAX, f32::min);
        let high = quote.history.iter().copied().fold(f32::MIN, f32::max);
        let field = |label: &'static str, value: String| {
            div()
                .flex()
                .flex_row()
                .justify_between()
                .py_0p5()
                .border_b_1()
                .border_color(rgb(0xf3f4f6))
                .child(div().text_color(rgb(0x6b7280)).child(label))
                .child(value)
        };

        div()
            .flex()
            .flex_col()
            .w(px(280.))
            .flex_shrink_0()
            .p_4()
            .gap_3()
            .bg(rgb(0xfcfcfd))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_xl()
                            .font_weight(FontWeight::BOLD)
                            .child(quote.symbol.clone()),
                    )
                    .child(div().text_color(rgb(0x6b7280)).child(quote.name.clone())),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_end()
                    .gap_2()
                    .child(div().text_2xl().child(format!("{:.2}", quote.price)))
                    .child(div().text_color(color).child(format!(
                        "{:+.2} ({:+.2}%)",
                        quote.change(),
                        quote.change_percent()
                    ))),
            )
            .child(sparkline(&quote.history, 12., 80., color))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .child(field("Prev close", format!("{:.2}", quote.prev_close)))
                    .child(field("Range high", format!("{high:.2}")))
                    .child(field("Range low", format!("{low:.2}")))
                    .child(field("Volume", format_volume(quote.volume)))
                    .child(field(
                        "Status",
                        match quote.status {
                            Status::Open => "Open",
                            Status::PreMarket => "Pre-market",
                            Status::Halted => "Halted",
                        }
                        .to_string(),
                    )),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap_2()
                    .child(
                        div()
                            .id("detail-buy")
                            .flex_1()
                            .py_1()
                            .rounded_md()
                            .text_center()
                            .bg(rgb(0x16a34a))
                            .text_color(rgb(0xffffff))
                            .hover(|style| style.bg(rgb(0x15803d)))
                            .child("Buy"),
                    )
                    .child(
                        div()
                            .id("detail-sell")
                            .flex_1()
                            .py_1()
                            .rounded_md()
                            .text_center()
                            .bg(rgb(0xdc2626))
                            .text_color(rgb(0xffffff))
                            .hover(|style| style.bg(rgb(0xb91c1c)))
                            .child("Sell"),
                    ),
            )
    }
}
