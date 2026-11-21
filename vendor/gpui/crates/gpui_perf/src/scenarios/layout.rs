//! A watchlist: a toolbar above a table of quote rows, redrawn every frame
//! with exactly one kind of change.
//!
//! Where the other scenarios simulate what a user does, these isolate what the
//! layout engine charges for a given kind of change. The tree's *shape* is
//! stable across frames while its *content* is not, which is the common case
//! in a live application. `layout-unchanged` is the floor, `layout-colors`
//! changes nothing the layout engine can see, `layout-text` changes leaf
//! measurements, and the `layout-rows*` scenarios change the shape of the
//! tree.

use gpui::{
    AnyView, App, AppContext as _, Context, Entity, FontWeight, Hsla, IntoElement, Render,
    SharedString, Window, div, hsla, prelude::*, px,
};

pub fn scenarios() -> Vec<Box<dyn crate::Scenario>> {
    vec![
        Box::new(LayoutScenario {
            name: "layout-unchanged",
            description: "A 200-row watchlist whose model is untouched; the view is only asked to redraw.",
            mutation: Mutation::None,
            keyed: false,
            panel: false,
        }),
        Box::new(LayoutScenario {
            name: "layout-colors",
            description: "A 200-row watchlist where every row changes color each frame, and nothing else.",
            mutation: Mutation::Colors,
            keyed: false,
            panel: false,
        }),
        Box::new(LayoutScenario {
            name: "layout-text",
            description: "A 200-row watchlist where every row's numeric cells change text each frame.",
            mutation: Mutation::Text,
            keyed: false,
            panel: false,
        }),
        Box::new(LayoutScenario {
            name: "layout-rows",
            description: "A 200-row watchlist that adds and removes rows at the end each frame.",
            mutation: Mutation::Rows,
            keyed: false,
            panel: false,
        }),
        Box::new(LayoutScenario {
            name: "layout-rows-at-head",
            description: "A 200-row watchlist that adds and removes rows at the front each frame, rows keyed by position.",
            mutation: Mutation::RowsAtHead,
            keyed: false,
            panel: false,
        }),
        Box::new(LayoutScenario {
            name: "layout-rows-at-head-keyed",
            description: "A 200-row watchlist that adds and removes rows at the front each frame, each row carrying its own ElementId.",
            mutation: Mutation::RowsAtHead,
            keyed: true,
            panel: false,
        }),
        Box::new(LayoutScenario {
            name: "layout-panel",
            description: "A 200-row watchlist whose cells change text each frame, beside a 200-entry panel that never changes.",
            mutation: Mutation::Text,
            keyed: false,
            panel: true,
        }),
    ]
}

const ROW_COUNT: usize = 200;

struct LayoutScenario {
    name: &'static str,
    description: &'static str,
    mutation: Mutation,
    keyed: bool,
    panel: bool,
}

impl crate::Scenario for LayoutScenario {
    fn name(&self) -> &'static str {
        self.name
    }

    fn description(&self) -> &'static str {
        self.description
    }

    fn build(&self, _: &mut Window, cx: &mut App) -> AnyView {
        let (mutation, keyed, panel) = (self.mutation, self.keyed, self.panel);
        cx.new(|cx| {
            let mut table = QuoteTable::new(ROW_COUNT, mutation);
            table.keyed = keyed;
            if panel {
                table.panel = Some(cx.new(|_| StaticPanel { entries: ROW_COUNT }));
            }
            table
        })
        .into()
    }

    fn step(&self, root: &AnyView, _: usize, _: &mut Window, cx: &mut App) {
        let table: Entity<QuoteTable> = root.clone().downcast().unwrap();
        table.update(cx, |table, cx| {
            table.tick();
            cx.notify();
        });
    }
}

/// How a frame differs from the one before it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mutation {
    /// The model is untouched; the view is only asked to redraw.
    None,
    /// Colors change. No text and no geometry changes, so nothing that reaches
    /// the layout engine's idea of the tree changes at all.
    Colors,
    /// Cell text changes. Styles and tree shape are untouched, but the measured
    /// size of some leaves may differ.
    Text,
    /// Rows are added and removed at the end, changing the shape of the tree
    /// without disturbing the rows already in it.
    Rows,
    /// Rows are added and removed at the *front*, so every remaining row shifts
    /// position. Rows keyed only by position are rebuilt wholesale; rows
    /// carrying a stable [`ElementId`](gpui::ElementId) should not be.
    RowsAtHead,
}

struct Row {
    /// Stable across the row's life, independent of where it currently sits.
    id: u64,
    symbol: SharedString,
    name: SharedString,
    last: SharedString,
    change: SharedString,
    volume: SharedString,
    up: bool,
}

impl Row {
    fn new(index: usize) -> Self {
        let mut row = Row {
            id: index as u64,
            symbol: SharedString::default(),
            name: SharedString::default(),
            last: SharedString::default(),
            change: SharedString::default(),
            volume: SharedString::default(),
            up: !index.is_multiple_of(3),
        };
        row.symbol = format!("{:04}.HK", (index * 37) % 9999).into();
        row.name = NAMES[index % NAMES.len()].into();
        row.retick(index as u64);
        row
    }

    /// Rewrites the numeric cells the way a quote feed would.
    fn retick(&mut self, tick: u64) {
        let seed = tick
            .wrapping_mul(2_654_435_761)
            .wrapping_add(self.symbol.len() as u64);
        let price = 10.0 + (seed % 90_000) as f64 / 1000.0;
        let change = (seed % 2_000) as f64 / 100.0 - 10.0;
        self.last = format!("{price:.3}").into();
        self.change = format!("{change:+.2}%").into();
        self.volume = format!("{}.{}M", seed % 900 + 10, seed % 10).into();
        self.up = change >= 0.0;
    }
}

const NAMES: &[&str] = &[
    "Tencent Holdings",
    "Alibaba Group",
    "HSBC Holdings",
    "Meituan",
    "China Mobile",
    "AIA Group",
    "Xiaomi Corporation",
    "BYD Company",
    "Ping An Insurance",
    "JD.com",
    "NetEase",
    "Li Auto",
];

/// A panel that never changes, standing in for the parts of an application that
/// are redrawn every frame despite having nothing new to say: sidebars,
/// toolbars, status bars, inactive tabs.
struct StaticPanel {
    entries: usize,
}

impl Render for StaticPanel {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .w(px(240.))
            .children((0..self.entries).map(|index| {
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .py_1()
                    .h(px(28.))
                    .border_b_1()
                    .border_color(BORDER)
                    .child(div().w(px(6.)).h(px(6.)).rounded_full().bg(FG_MUTED))
                    .child(div().flex_1().child(NAMES[index % NAMES.len()]))
                    .child(div().w(px(48.)).text_right().text_xs().child("--"))
            }))
    }
}

/// A watchlist-shaped view: a toolbar above a table of quote rows.
struct QuoteTable {
    rows: Vec<Row>,
    base_row_count: usize,
    tick: u64,
    next_row_id: u64,
    mutation: Mutation,
    /// Whether each row carries an [`ElementId`](gpui::ElementId) of its own.
    ///
    /// Without one a row is identified by its index among its siblings, which
    /// is only stable while nothing is inserted ahead of it.
    keyed: bool,
    /// The half of the interface that has nothing new to say each frame.
    panel: Option<Entity<StaticPanel>>,
}

impl QuoteTable {
    fn new(row_count: usize, mutation: Mutation) -> Self {
        QuoteTable {
            rows: (0..row_count).map(Row::new).collect(),
            base_row_count: row_count,
            tick: 0,
            next_row_id: row_count as u64,
            mutation,
            keyed: false,
            panel: None,
        }
    }

    fn new_row(&mut self) -> Row {
        let mut row = Row::new(self.rows.len());
        row.id = self.next_row_id;
        self.next_row_id += 1;
        row
    }

    /// Advances the model by one frame's worth of change.
    fn tick(&mut self) {
        self.tick += 1;
        match self.mutation {
            Mutation::None => {}
            Mutation::Colors => {
                for row in &mut self.rows {
                    row.up = !row.up;
                }
            }
            Mutation::Text => {
                let tick = self.tick;
                for row in &mut self.rows {
                    row.retick(tick);
                }
            }
            Mutation::Rows => {
                // Oscillate around the configured size so the row count, and
                // therefore the shape of the tree, differs every frame.
                let target = self.base_row_count - (self.tick % 8) as usize;
                while self.rows.len() > target {
                    self.rows.pop();
                }
                while self.rows.len() < target {
                    let row = self.new_row();
                    self.rows.push(row);
                }
            }
            Mutation::RowsAtHead => {
                let target = self.base_row_count - (self.tick % 8) as usize;
                while self.rows.len() > target {
                    self.rows.remove(0);
                }
                while self.rows.len() < target {
                    let row = self.new_row();
                    self.rows.insert(0, row);
                }
            }
        }
    }
}

const FG: Hsla = hsla(0.0, 0.0, 0.85, 1.0);
const FG_MUTED: Hsla = hsla(0.0, 0.0, 0.55, 1.0);
const BG: Hsla = hsla(0.62, 0.15, 0.12, 1.0);
const BORDER: Hsla = hsla(0.62, 0.10, 0.22, 1.0);
const UP: Hsla = hsla(0.38, 0.55, 0.55, 1.0);
const DOWN: Hsla = hsla(0.99, 0.60, 0.60, 1.0);

impl Render for QuoteTable {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_row()
            .size_full()
            .bg(BG)
            .text_color(FG)
            .children(self.panel.clone())
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap_3()
                            .px_4()
                            .py_2()
                            .border_b_1()
                            .border_color(BORDER)
                            .child(div().font_weight(FontWeight::SEMIBOLD).child("Watchlist"))
                            .child(div().flex_1())
                            .children(["All", "HK", "US", "A"].map(|label| {
                                div()
                                    .px_2()
                                    .py_1()
                                    .rounded_md()
                                    .bg(BORDER)
                                    .text_sm()
                                    .child(label)
                            })),
                    )
                    .children(self.rows.iter().map(|row| {
                        let tone = if row.up { UP } else { DOWN };
                        let row_element = div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap_2()
                            .px_4()
                            .py_1()
                            .border_b_1()
                            .border_color(BORDER)
                            .child(div().w(px(6.)).h(px(6.)).rounded_full().bg(tone))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .w(px(110.))
                                    .child(row.symbol.clone())
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(FG_MUTED)
                                            .child(row.name.clone()),
                                    ),
                            )
                            // Content-sized: text here genuinely participates in layout.
                            .child(
                                div()
                                    .flex_1()
                                    .text_xs()
                                    .text_color(FG_MUTED)
                                    .child(row.name.clone()),
                            )
                            // Fixed-width columns: text here cannot move anything.
                            .child(div().w(px(96.)).text_right().child(row.last.clone()))
                            .child(
                                div()
                                    .w(px(84.))
                                    .text_right()
                                    .text_color(tone)
                                    .child(row.change.clone()),
                            )
                            .child(
                                div()
                                    .w(px(84.))
                                    .text_right()
                                    .text_color(FG_MUTED)
                                    .child(row.volume.clone()),
                            );
                        if self.keyed {
                            row_element.id(("row", row.id)).into_any_element()
                        } else {
                            row_element.into_any_element()
                        }
                    })),
            )
    }
}
