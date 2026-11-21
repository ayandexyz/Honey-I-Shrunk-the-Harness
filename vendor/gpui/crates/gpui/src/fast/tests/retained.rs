//! Tests of views drawn again from what they drew on the last frame. See
//! [`crate::fast::retained`].

use crate::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, StyleRefinement, Styled as _, TestAppContext, Window, WindowHandle, div,
    prelude::FluentBuilder as _, px,
};
use std::{cell::Cell, rc::Rc};

struct Row {
    label: u32,
    builds: Rc<Cell<usize>>,
}

impl Render for Row {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        div()
            .size_full()
            .bg(crate::black())
            .hover(|style| style.bg(crate::white()))
            .child(format!("row {}", self.label))
    }
}

struct Rows {
    row: Entity<Row>,
    covered: bool,
}

impl Render for Rows {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .relative()
            .size(px(300.))
            .child(
                self.row
                    .clone()
                    .cached(StyleRefinement::default().w(px(100.)).h(px(20.))),
            )
            .when(self.covered, |this| {
                this.child(div().absolute().top_0().left_0().size(px(200.)).occlude())
            })
    }
}

fn window(cx: &mut TestAppContext) -> (WindowHandle<Rows>, Entity<Row>, Rc<Cell<usize>>) {
    let builds = Rc::new(Cell::new(0));
    let window = cx.add_window({
        let builds = builds.clone();
        move |_, cx| Rows {
            row: cx.new(|_| Row { label: 0, builds }),
            covered: false,
        }
    });
    let row = window.update(cx, |rows, _, _| rows.row.clone()).unwrap();
    (window, row, builds)
}

fn draw(cx: &mut TestAppContext, window: WindowHandle<Rows>) -> Vec<String> {
    cx.update_window(window.into(), |_, window, cx| {
        window.draw(cx).clear(cx);
        window.describe_rendered_frame()
    })
    .unwrap()
}

fn notify_parent(cx: &mut TestAppContext, window: WindowHandle<Rows>) {
    window.update(cx, |_, _, cx| cx.notify()).unwrap();
}

fn move_mouse(cx: &mut TestAppContext, window: WindowHandle<Rows>, x: f32, y: f32) {
    cx.update_window(window.into(), |_, window, cx| {
        window.simulate_mouse_move(crate::point(px(x), px(y)), cx);
    })
    .unwrap();
}

/// A cached view painted while the pointer was over something in it that
/// has a hover style is rendered again once the pointer leaves, even
/// though the element never saw the pointer arrive.
#[test]
fn a_cached_view_is_rendered_again_when_a_hover_it_was_painted_by_changes() {
    let mut cx = TestAppContext::single();
    let (window, _, builds) = window(&mut cx);
    move_mouse(&mut cx, window, 10., 10.);
    let hovered = draw(&mut cx, window);
    notify_parent(&mut cx, window);
    draw(&mut cx, window);
    let builds_before = builds.get();

    move_mouse(&mut cx, window, 250., 250.);
    let left = draw(&mut cx, window);
    assert_eq!(builds.get(), builds_before + 1);
    assert_ne!(hovered, left);
}

/// A cached view reused for a while keeps the layout nodes it was laid
/// out with, so rendering it again finds them all.
#[test]
fn a_reused_cached_view_keeps_its_layout_nodes() {
    let mut cx = TestAppContext::single();
    let (window, row, builds) = window(&mut cx);
    draw(&mut cx, window);
    for _ in 0..3 {
        notify_parent(&mut cx, window);
        draw(&mut cx, window);
    }
    assert_eq!(
        builds.get(),
        1,
        "the view is reused while its parent renders"
    );

    cx.update_window(window.into(), |_, window, _| window.reset_layout_stats())
        .unwrap();
    row.update(&mut cx, |row, cx| {
        row.label = 7;
        cx.notify();
    });
    draw(&mut cx, window);
    assert_eq!(builds.get(), 2);
    let stats = cx
        .update_window(window.into(), |_, window, _| window.layout_stats())
        .unwrap();
    assert_eq!(
        stats.nodes_created, 0,
        "the view's nodes should have been kept while it was reused"
    );
    assert!(stats.nodes_reused > 0);
}

/// Something drawn over a hovered cached view is found out only when the
/// view paints; it is rendered on the next frame, which is asked for.
#[test]
fn a_cached_view_covered_while_hovered_is_rendered_on_the_next_frame() {
    let mut cx = TestAppContext::single();
    let (window, _, builds) = window(&mut cx);
    move_mouse(&mut cx, window, 10., 10.);
    let hovered = draw(&mut cx, window);
    notify_parent(&mut cx, window);
    draw(&mut cx, window);
    let builds_before = builds.get();

    window
        .update(&mut cx, |rows, _, cx| {
            rows.covered = true;
            cx.notify();
        })
        .unwrap();
    let frame_asked_for = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, _| {
            !window.next_frame_callbacks.borrow().is_empty()
        })
        .unwrap()
    };
    let mut asked_for_a_frame = frame_asked_for(&mut cx);
    let mut look = None;
    for _ in 0..3 {
        if builds.get() > builds_before {
            break;
        }
        asked_for_a_frame |= frame_asked_for(&mut cx);
        look = Some(draw(&mut cx, window));
    }
    assert_eq!(builds.get(), builds_before + 1);
    assert!(
        asked_for_a_frame,
        "a frame should be asked for to render it"
    );
    assert_ne!(Some(hovered), look);
}

struct Counted {
    label: usize,
    model: Option<Entity<Model>>,
    builds: Rc<Cell<usize>>,
}

struct Model(usize);

impl Render for Counted {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        let model = self.model.as_ref().map_or(0, |model| model.read(cx).0);
        div()
            .flex()
            .flex_row()
            .child(format!("{} {}", self.label, model))
    }
}

struct Siblings {
    first: Entity<Counted>,
    second: Entity<Counted>,
    spacer: f32,
}

impl Render for Siblings {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .child(div().h(px(self.spacer)))
            .child(self.first.clone())
            .child(self.second.clone())
    }
}

struct SiblingsWindow {
    window: WindowHandle<Siblings>,
    first: Entity<Counted>,
    model: Entity<Model>,
    first_builds: Rc<Cell<usize>>,
    second_builds: Rc<Cell<usize>>,
}

fn siblings(cx: &mut TestAppContext) -> SiblingsWindow {
    let first_builds = Rc::new(Cell::new(0));
    let second_builds = Rc::new(Cell::new(0));
    let model = cx.new(|_| Model(0));
    let window = cx.add_window({
        let (first_builds, second_builds, model) =
            (first_builds.clone(), second_builds.clone(), model.clone());
        move |_, cx| Siblings {
            first: cx.new(|_| Counted {
                label: 1,
                model: None,
                builds: first_builds,
            }),
            second: cx.new(|_| Counted {
                label: 2,
                model: Some(model),
                builds: second_builds,
            }),
            spacer: 10.,
        }
    });
    let first = window.update(cx, |view, _, _| view.first.clone()).unwrap();
    SiblingsWindow {
        window,
        first,
        model,
        first_builds,
        second_builds,
    }
}

fn draw_siblings(cx: &mut TestAppContext, window: WindowHandle<Siblings>) -> Vec<String> {
    cx.update_window(window.into(), |_, window, cx| {
        window.draw(cx).clear(cx);
        window.describe_rendered_frame()
    })
    .unwrap()
}

/// A view that is not cached is drawn again from the
/// last frame while nothing it read changed, even when the view around it
/// is rendered again, and rendered again once something it read did.
#[test]
fn a_view_is_rendered_again_only_when_something_it_read_changed() {
    let mut cx = TestAppContext::single();
    let s = siblings(&mut cx);
    draw_siblings(&mut cx, s.window);
    assert_eq!((s.first_builds.get(), s.second_builds.get()), (1, 1));

    s.window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
    draw_siblings(&mut cx, s.window);
    assert_eq!(
        (s.first_builds.get(), s.second_builds.get()),
        (1, 1),
        "notifying the parent leaves its children alone"
    );

    s.first.update(&mut cx, |first, cx| {
        first.label = 3;
        cx.notify();
    });
    draw_siblings(&mut cx, s.window);
    assert_eq!((s.first_builds.get(), s.second_builds.get()), (2, 1));

    s.model.update(&mut cx, |model, cx| {
        model.0 = 5;
        cx.notify();
    });
    draw_siblings(&mut cx, s.window);
    assert_eq!(
        (s.first_builds.get(), s.second_builds.get()),
        (2, 2),
        "a model the view read changing renders it again, unobserved"
    );

    cx.update_window(s.window.into(), |_, window, _| window.refresh())
        .unwrap();
    draw_siblings(&mut cx, s.window);
    assert_eq!((s.first_builds.get(), s.second_builds.get()), (3, 3));
}

/// A view that moved is built again where it went, at the layout nodes it
/// kept, and draws what a window drawing from scratch draws.
#[test]
fn a_moved_view_is_built_again_at_its_layout() {
    let mut cx = TestAppContext::single();
    let s = siblings(&mut cx);
    draw_siblings(&mut cx, s.window);
    s.window
        .update(&mut cx, |view, _, cx| {
            view.spacer = 30.;
            cx.notify();
        })
        .unwrap();
    cx.update_window(s.window.into(), |_, window, _| window.reset_layout_stats())
        .unwrap();
    let moved = draw_siblings(&mut cx, s.window);
    assert_eq!((s.first_builds.get(), s.second_builds.get()), (2, 2));
    let stats = cx
        .update_window(s.window.into(), |_, window, _| window.layout_stats())
        .unwrap();
    assert_eq!(stats.nodes_created, 0, "the moved views keep their nodes");

    cx.update_window(s.window.into(), |_, window, _| {
        window.forget_retained_state()
    })
    .unwrap();
    assert_eq!(moved, draw_siblings(&mut cx, s.window));
}

/// With retention turned off, every view is rendered every frame.
#[test]
fn views_are_rendered_every_frame_without_retention() {
    let mut cx = TestAppContext::single();
    let s = siblings(&mut cx);
    cx.update_window(s.window.into(), |_, window, _| {
        window.set_view_retention(false)
    })
    .unwrap();
    draw_siblings(&mut cx, s.window);
    let before = (s.first_builds.get(), s.second_builds.get());
    s.window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
    draw_siblings(&mut cx, s.window);
    assert!(s.first_builds.get() > before.0 && s.second_builds.get() > before.1);
}

struct Sized {
    row: Entity<Row>,
    width: f32,
}

impl Render for Sized {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().child(
            self.row
                .clone()
                .cached(StyleRefinement::default().w(px(self.width)).h(px(20.))),
        )
    }
}

/// A cached view is rendered again when its bounds change or the window is
/// refreshed, and otherwise reused, showing what it showed.
#[test]
fn a_cached_view_is_rendered_again_only_when_it_has_to_be() {
    let mut cx = TestAppContext::single();
    let builds = Rc::new(Cell::new(0));
    let window = cx.add_window({
        let builds = builds.clone();
        move |_, cx| Sized {
            row: cx.new(|_| Row { label: 0, builds }),
            width: 100.,
        }
    });
    let draw = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.describe_rendered_frame()
        })
        .unwrap()
    };
    let change = |cx: &mut TestAppContext, f: fn(&mut Sized)| {
        window
            .update(cx, |view, _, cx| {
                f(view);
                cx.notify();
            })
            .unwrap()
    };

    let first = draw(&mut cx);
    assert_eq!(builds.get(), 1);
    change(&mut cx, |_| {});
    assert_eq!(first, draw(&mut cx), "a reused view shows what it showed");
    assert_eq!(builds.get(), 1);

    change(&mut cx, |view| view.width = 150.);
    draw(&mut cx);
    assert_eq!(builds.get(), 2, "new bounds render it again");

    cx.update_window(window.into(), |_, window, _| window.refresh())
        .unwrap();
    draw(&mut cx);
    assert_eq!(builds.get(), 3, "a refreshed window renders every view");

    cx.simulate_window_resize(window.into(), crate::size(px(800.), px(600.)));
    draw(&mut cx);
    change(&mut cx, |_| {});
    draw(&mut cx);
    assert_eq!(
        builds.get(),
        4,
        "a resize refreshes once, then it is reused"
    );
}

struct PopoverRow {
    builds: Rc<Cell<usize>>,
}

impl Render for PopoverRow {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        div().size_full().child(crate::deferred(
            div()
                .id("popover")
                .w(px(50.))
                .h(px(20.))
                .bg(crate::black())
                .hover(|style| style.bg(crate::white())),
        ))
    }
}

struct WithPopover {
    row: Entity<PopoverRow>,
}

impl Render for WithPopover {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().child(
            self.row
                .clone()
                .cached(StyleRefinement::default().w(px(100.)).h(px(20.))),
        )
    }
}

/// Something a cached view draws deferred, such as a popover, is prepainted
/// and painted after the view, but is part of what the view drew: the pointer
/// moving over it changes how the view looks.
#[test]
fn a_cached_view_is_rendered_again_when_the_pointer_moves_over_what_it_deferred() {
    let mut cx = TestAppContext::single();
    let builds = Rc::new(Cell::new(0));
    let window = cx.add_window({
        let builds = builds.clone();
        move |_, cx| WithPopover {
            row: cx.new(|_| PopoverRow { builds }),
        }
    });
    let draw = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.describe_rendered_frame()
        })
        .unwrap()
    };
    let move_to = |cx: &mut TestAppContext, x: f32, y: f32| {
        cx.update_window(window.into(), |_, window, cx| {
            window.simulate_mouse_move(crate::point(px(x), px(y)), cx);
        })
        .unwrap();
    };

    // The pointer starts out at the origin, over the popover.
    draw(&mut cx);
    assert_eq!(builds.get(), 1);
    move_to(&mut cx, 500., 500.);
    let away = draw(&mut cx);
    assert_eq!(
        builds.get(),
        2,
        "the pointer leaving the popover changes its look"
    );
    window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
    draw(&mut cx);
    assert_eq!(builds.get(), 2, "and nothing else does");

    move_to(&mut cx, 10., 10.);
    let over = draw(&mut cx);
    assert_eq!(builds.get(), 3, "the pointer coming back changes it again");
    assert_ne!(away, over);

    move_to(&mut cx, 500., 500.);
    let away_again = draw(&mut cx);
    assert_eq!(builds.get(), 4);
    assert_eq!(away, away_again);
}

/// An input handler that answers every question about its text with its
/// name, so a test can tell which one the platform was handed.
struct NamedInput(&'static str);

impl crate::InputHandler for NamedInput {
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut crate::App,
    ) -> Option<crate::UTF16Selection> {
        None
    }
    fn marked_text_range(
        &mut self,
        _: &mut Window,
        _: &mut crate::App,
    ) -> Option<std::ops::Range<usize>> {
        None
    }
    fn text_for_range(
        &mut self,
        _: std::ops::Range<usize>,
        _: &mut Option<std::ops::Range<usize>>,
        _: &mut Window,
        _: &mut crate::App,
    ) -> Option<String> {
        Some(self.0.to_string())
    }
    fn replace_text_in_range(
        &mut self,
        _: Option<std::ops::Range<usize>>,
        _: &str,
        _: &mut Window,
        _: &mut crate::App,
    ) {
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<std::ops::Range<usize>>,
        _: &str,
        _: Option<std::ops::Range<usize>>,
        _: &mut Window,
        _: &mut crate::App,
    ) {
    }
    fn unmark_text(&mut self, _: &mut Window, _: &mut crate::App) {}
    fn bounds_for_range(
        &mut self,
        _: std::ops::Range<usize>,
        _: &mut Window,
        _: &mut crate::App,
    ) -> Option<crate::Bounds<crate::Pixels>> {
        None
    }
    fn character_index_for_point(
        &mut self,
        _: crate::Point<crate::Pixels>,
        _: &mut Window,
        _: &mut crate::App,
    ) -> Option<usize> {
        None
    }
}

fn text_input(focus: crate::FocusHandle, name: &'static str) -> impl IntoElement {
    crate::canvas(
        |_, _, _| {},
        move |_, _, window, cx| window.handle_input(&focus, NamedInput(name), cx),
    )
    .size_full()
}

struct Field {
    focus: crate::FocusHandle,
    builds: Rc<Cell<usize>>,
}

impl Render for Field {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        text_input(self.focus.clone(), "inside")
    }
}

struct Inputs {
    field: Entity<Field>,
    outside: crate::FocusHandle,
    cached_first: bool,
}

impl Render for Inputs {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let cached = self
            .field
            .clone()
            .cached(StyleRefinement::default().w(px(100.)).h(px(20.)))
            .into_any_element();
        let outside = div()
            .w(px(100.))
            .h(px(20.))
            .child(text_input(self.outside.clone(), "outside"))
            .into_any_element();
        let children = if self.cached_first {
            [cached, outside]
        } else {
            [outside, cached]
        };
        div().children(children)
    }
}

/// The input handler of a focused field inside a reused cached view is
/// handed to the platform on every frame, and a field focused elsewhere
/// takes over.
#[test]
fn a_reused_cached_view_hands_the_platform_its_input_handler() {
    for cached_first in [true, false] {
        let mut cx = TestAppContext::single();
        let builds = Rc::new(Cell::new(0));
        let window = cx.add_window({
            let builds = builds.clone();
            move |_, cx| Inputs {
                field: cx.new(|cx| Field {
                    focus: cx.focus_handle(),
                    builds,
                }),
                outside: cx.focus_handle(),
                cached_first,
            }
        });
        let (inside, outside) = window
            .update(&mut cx, |view, _, cx| {
                (view.field.read(cx).focus.clone(), view.outside.clone())
            })
            .unwrap();
        let draw = |cx: &mut TestAppContext| {
            cx.update_window(window.into(), |_, window, cx| window.draw(cx).clear(cx))
                .unwrap()
        };
        // Asked outside of any update, as the platform asks it.
        let handed = |cx: &mut TestAppContext| {
            let mut handler = cx
                .update_window(window.into(), |_, window, _| {
                    window.platform_window.take_input_handler()
                })
                .unwrap()?;
            let name = handler.text_for_range(0..1, &mut None);
            cx.update_window(window.into(), |_, window, _| {
                window.platform_window.set_input_handler(handler)
            })
            .unwrap();
            name
        };
        let focus = |cx: &mut TestAppContext, handle: &crate::FocusHandle| {
            cx.update_window(window.into(), |_, window, cx| window.focus(handle, cx))
                .unwrap()
        };

        focus(&mut cx, &inside);
        draw(&mut cx);
        assert_eq!(handed(&mut cx).as_deref(), Some("inside"));
        let builds_then = builds.get();
        for _ in 0..3 {
            window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
            draw(&mut cx);
            assert_eq!(handed(&mut cx).as_deref(), Some("inside"));
        }
        assert_eq!(builds.get(), builds_then, "the cached view was reused");

        focus(&mut cx, &outside);
        draw(&mut cx);
        assert_eq!(handed(&mut cx).as_deref(), Some("outside"));
        window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
        draw(&mut cx);
        assert_eq!(handed(&mut cx).as_deref(), Some("outside"));

        focus(&mut cx, &inside);
        draw(&mut cx);
        window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
        draw(&mut cx);
        assert_eq!(handed(&mut cx).as_deref(), Some("inside"));
    }
}

/// A card whose width comes from the column it sits in, not from its content.
struct Card;

impl Render for Card {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .items_center()
            .child(div().h(px(10.)).bg(crate::black()).child("card"))
    }
}

struct Stretched {
    card: Entity<Card>,
    spacer: f32,
}

impl Render for Stretched {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .w(px(300.))
            .child(div().h(px(self.spacer)))
            .child(self.card.clone())
    }
}

/// A view stretched by the column it is in keeps that width when it moves,
/// as when a scrolled list moves every view in it: it is laid out again at
/// the size its parent gave it, not at the size its content asks for.
#[test]
fn a_moved_view_keeps_the_size_its_parent_gave_it() {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(|_, cx| Stretched {
        card: cx.new(|_| Card),
        spacer: 10.,
    });
    let draw = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.describe_rendered_frame()
        })
        .unwrap()
    };
    draw(&mut cx);
    window
        .update(&mut cx, |view, _, cx| {
            view.spacer = 30.;
            cx.notify();
        })
        .unwrap();
    let moved = draw(&mut cx);
    cx.update_window(window.into(), |_, window, _| window.forget_retained_state())
        .unwrap();
    assert_eq!(moved, draw(&mut cx));
}

/// A view that read a model updated without being notified is built again
/// when the view around it is, as upstream builds every view under a
/// notified one again: a view often changes a model it renders and notifies
/// only itself.
#[test]
fn a_view_is_rendered_again_when_a_model_it_read_was_updated_without_a_notify() {
    let mut cx = TestAppContext::single();
    let s = siblings(&mut cx);
    draw_siblings(&mut cx, s.window);
    assert_eq!((s.first_builds.get(), s.second_builds.get()), (1, 1));

    s.model.update(&mut cx, |model, _| model.0 = 7);
    s.window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
    let updated = draw_siblings(&mut cx, s.window);
    assert_eq!(
        (s.first_builds.get(), s.second_builds.get()),
        (1, 2),
        "only the view that read the model is built again"
    );

    s.window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
    draw_siblings(&mut cx, s.window);
    assert_eq!(
        (s.first_builds.get(), s.second_builds.get()),
        (1, 2),
        "an update is seen once"
    );

    cx.update_window(s.window.into(), |_, window, _| {
        window.forget_retained_state()
    })
    .unwrap();
    assert_eq!(updated, draw_siblings(&mut cx, s.window));
}

/// A view built again keeps the measurements of the text that did not
/// change, rather than measuring and laying it out again, and measures the
/// text that did.
#[test]
fn text_that_did_not_change_keeps_its_measurement() {
    let mut cx = TestAppContext::single();
    let s = siblings(&mut cx);
    draw_siblings(&mut cx, s.window);
    let stats = |cx: &mut TestAppContext| {
        cx.update_window(s.window.into(), |_, window, _| window.layout_stats())
            .unwrap()
    };
    let reset = |cx: &mut TestAppContext| {
        cx.update_window(s.window.into(), |_, window, _| window.reset_layout_stats())
            .unwrap()
    };

    reset(&mut cx);
    s.window
        .update(&mut cx, |view, _, cx| {
            view.spacer = 30.;
            cx.notify();
        })
        .unwrap();
    draw_siblings(&mut cx, s.window);
    let after_move = stats(&mut cx);
    assert_eq!(
        after_move.measure_rebinds, 0,
        "moved text is not measured again"
    );
    assert_eq!(after_move.measurements_kept, 2);

    reset(&mut cx);
    s.first.update(&mut cx, |first, cx| {
        first.label = 9;
        cx.notify();
    });
    let changed = draw_siblings(&mut cx, s.window);
    let after_change = stats(&mut cx);
    assert_eq!(
        after_change.measure_rebinds, 1,
        "changed text is measured again"
    );

    cx.update_window(s.window.into(), |_, window, _| {
        window.forget_retained_state()
    })
    .unwrap();
    assert_eq!(changed, draw_siblings(&mut cx, s.window));
}

/// A view that reads what a nested view holds, as a gallery reads the name of
/// the page it shows.
struct Reader {
    child: Entity<Counted>,
    builds: Rc<Cell<usize>>,
}

impl Render for Reader {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        let label = self.child.read(cx).label;
        div()
            .flex()
            .flex_col()
            .child(format!("showing {label}"))
            .child(self.child.clone())
    }
}

/// A view notified without being updated, as a scroll wheel or a dragged
/// scrollbar notifies it, is drawn again on its own: a view that read it is
/// drawn around it from last frame. Once it is updated, what that view read
/// may have changed, and it is built again.
#[test]
fn a_view_that_read_a_notified_view_is_built_again_only_if_it_was_updated() {
    let mut cx = TestAppContext::single();
    let reader_builds = Rc::new(Cell::new(0));
    let child_builds = Rc::new(Cell::new(0));
    let window = cx.add_window({
        let (reader_builds, child_builds) = (reader_builds.clone(), child_builds.clone());
        move |_, cx| Reader {
            child: cx.new(|_| Counted {
                label: 1,
                model: None,
                builds: child_builds,
            }),
            builds: reader_builds,
        }
    });
    let child = window.read_with(&cx, |view, _| view.child.clone()).unwrap();
    let draw = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.describe_rendered_frame()
        })
        .unwrap()
    };
    draw(&mut cx);
    let first = (reader_builds.get(), child_builds.get());

    cx.update(|cx| cx.notify(child.entity_id()));
    draw(&mut cx);
    assert_eq!(
        (reader_builds.get(), child_builds.get()),
        (first.0, first.1 + 1),
        "a notification alone changes nothing the reader read"
    );

    child.update(&mut cx, |child, cx| {
        child.label = 2;
        cx.notify();
    });
    let updated = draw(&mut cx);
    assert_eq!(
        (reader_builds.get(), child_builds.get()),
        (first.0 + 1, first.1 + 2)
    );
    cx.update_window(window.into(), |_, window, _| window.forget_retained_state())
        .unwrap();
    assert_eq!(updated, draw(&mut cx));
}

/// The state of a view a component renders, written by the component as it
/// is rendered, the way a list or tree component hands its item renderer to
/// the view that draws the items.
struct Painter {
    color: crate::Hsla,
}

impl Render for Painter {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size(px(40.)).bg(self.color)
    }
}

/// A component that writes what it was given into its view's state, without
/// notifying it, and renders the view.
#[derive(IntoElement)]
struct Paint {
    painter: Entity<Painter>,
    color: crate::Hsla,
}

impl crate::RenderOnce for Paint {
    fn render(self, _: &mut Window, cx: &mut crate::App) -> impl IntoElement {
        let color = self.color;
        self.painter.update(cx, |painter, _| painter.color = color);
        self.painter
    }
}

struct PaintHost {
    painter: Entity<Painter>,
    red: bool,
}

impl Render for PaintHost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size(px(300.)).child(Paint {
            painter: self.painter.clone(),
            color: if self.red {
                crate::red()
            } else {
                crate::blue()
            },
        })
    }
}

fn backgrounds(cx: &mut TestAppContext, window: crate::AnyWindowHandle) -> Vec<String> {
    cx.update_window(window, |_, window, cx| {
        window.draw(cx).clear(cx);
        window
            .painted_quads()
            .iter()
            .map(|quad| format!("{:?} {:?}", quad.bounds, quad.background))
            .collect()
    })
    .unwrap()
}

/// A view whose state a component wrote while the window drew, as it was
/// rendered, is drawn with what was written: the write changed what the view
/// reads, notified or not.
#[test]
fn a_view_written_while_the_window_draws_is_rendered_again() {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(|_, cx| PaintHost {
        painter: cx.new(|_| Painter {
            color: crate::blue(),
        }),
        red: false,
    });
    let blue = backgrounds(&mut cx, window.into());
    assert_eq!(blue, backgrounds(&mut cx, window.into()));

    window
        .update(&mut cx, |host, _, cx| {
            host.red = true;
            cx.notify();
        })
        .unwrap();
    let red = backgrounds(&mut cx, window.into());
    assert_ne!(blue, red, "the painter was drawn with the color written");
    let again = backgrounds(&mut cx, window.into());
    assert_eq!(red, again, "and nothing wrote it since");

    // The host writing its painter as it is built is part of building it:
    // it does not make the host itself out of date.
    let reused = cx
        .update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.draw(cx).clear(cx);
            window.next_frame.retained.reused_any() || window.rendered_frame.retained.reused_any()
        })
        .unwrap();
    assert!(reused, "a frame where nothing changed reuses the views");
}

/// An element of its own that asks whether its hitbox is hovered while it is
/// painted — not a hover style — makes the view it is in depend on the answer.
struct HoverProbe;

impl Render for HoverProbe {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size(px(300.)).child(
            crate::canvas(
                |bounds, window, _| window.insert_hitbox(bounds, crate::HitboxBehavior::Normal),
                |bounds, hitbox, window, _| {
                    let color = if hitbox.is_hovered(window) {
                        crate::red()
                    } else {
                        crate::blue()
                    };
                    window.paint_quad(crate::fill(bounds, color));
                },
            )
            .size(px(100.)),
        )
    }
}

#[test]
fn a_view_is_rendered_again_when_a_hover_an_element_asked_about_changes() {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(|_, _| HoverProbe);
    let move_to = |cx: &mut TestAppContext, x: f32, y: f32| {
        cx.update_window(window.into(), |_, window, cx| {
            window.simulate_mouse_move(crate::point(px(x), px(y)), cx);
        })
        .unwrap();
    };
    move_to(&mut cx, 250., 250.);
    backgrounds(&mut cx, window.into());
    let away = backgrounds(&mut cx, window.into());
    move_to(&mut cx, 10., 10.);
    let over = backgrounds(&mut cx, window.into());
    assert_ne!(
        away, over,
        "the pointer over the element changes how it looks"
    );
    move_to(&mut cx, 250., 250.);
    assert_eq!(away, backgrounds(&mut cx, window.into()));
}

/// A view that reads where the pointer is, or which modifiers are held, as it
/// renders depends on it.
struct PointerProbe;

impl Render for PointerProbe {
    fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let x = window.mouse_position().x;
        let wide = window.modifiers().shift;
        div().size(px(300.)).child(
            div()
                .w(if wide { px(80.) } else { x })
                .h(px(10.))
                .bg(crate::red()),
        )
    }
}

#[test]
fn a_view_that_read_the_pointer_or_modifiers_is_rendered_again_when_they_change() {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(|_, _| PointerProbe);
    let at = |cx: &mut TestAppContext, x: f32, modifiers: crate::Modifiers| {
        cx.update_window(window.into(), |_, window, cx| {
            window.dispatch_event(
                crate::PlatformInput::MouseMove(crate::MouseMoveEvent {
                    position: crate::point(px(x), px(5.)),
                    pressed_button: None,
                    modifiers,
                }),
                cx,
            );
        })
        .unwrap();
        backgrounds(cx, window.into())
    };
    let first = at(&mut cx, 20., crate::Modifiers::default());
    let moved = at(&mut cx, 60., crate::Modifiers::default());
    assert_ne!(first, moved, "the view reads where the pointer is");
    let shifted = at(
        &mut cx,
        60.,
        crate::Modifiers {
            shift: true,
            ..Default::default()
        },
    );
    assert_ne!(moved, shifted, "and which modifiers are held");
}

struct Badge;

impl Render for Badge {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size(px(20.)).debug_selector(|| "badge".into())
    }
}

struct BadgeHost {
    badge: Entity<Badge>,
    chip: bool,
}

impl Render for BadgeHost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size(px(300.))
            .child(
                self.badge
                    .clone()
                    .cached(StyleRefinement::default().w(px(20.)).h(px(20.))),
            )
            .when(self.chip, |this| {
                this.child(div().size(px(10.)).debug_selector(|| "chip".into()))
            })
    }
}

/// Debug bounds a reused view recorded last frame stay findable, but those of
/// an element the rebuilt view around it no longer paints are gone, as they
/// are when every view is drawn from scratch.
#[test]
fn debug_bounds_follow_what_was_painted_while_a_sibling_view_is_reused() {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(|_, cx| BadgeHost {
        badge: cx.new(|_| Badge),
        chip: true,
    });
    let mut vcx = crate::VisualTestContext::from_window(window.into(), &cx);
    vcx.run_until_parked();
    assert!(vcx.debug_bounds("chip").is_some());
    assert!(vcx.debug_bounds("badge").is_some());

    window
        .update(&mut vcx, |host, _, cx| {
            host.chip = false;
            cx.notify();
        })
        .unwrap();
    vcx.run_until_parked();
    assert!(
        vcx.debug_bounds("chip").is_none(),
        "the chip is no longer painted"
    );
    assert!(
        vcx.debug_bounds("badge").is_some(),
        "the reused badge keeps last frame's bounds"
    );
}

/// A text input focused in a view is asked how it is configured after every
/// frame; that question does not change it, so the views that read it stay
/// drawn from the last frame.
struct FocusedInput {
    focus: crate::FocusHandle,
    builds: Rc<Cell<usize>>,
}

impl crate::EntityInputHandler for FocusedInput {
    fn text_for_range(
        &mut self,
        _: std::ops::Range<usize>,
        _: &mut Option<std::ops::Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        None
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<crate::UTF16Selection> {
        None
    }
    fn marked_text_range(
        &self,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<std::ops::Range<usize>> {
        None
    }
    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {}
    fn replace_text_in_range(
        &mut self,
        _: Option<std::ops::Range<usize>>,
        _: &str,
        _: &mut Window,
        _: &mut Context<Self>,
    ) {
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<std::ops::Range<usize>>,
        _: &str,
        _: Option<std::ops::Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) {
    }
    fn bounds_for_range(
        &mut self,
        _: std::ops::Range<usize>,
        _: crate::Bounds<crate::Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<crate::Bounds<crate::Pixels>> {
        None
    }
    fn character_index_for_point(
        &mut self,
        _: crate::Point<crate::Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}

impl Render for FocusedInput {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        let entity = cx.entity();
        let focus = self.focus.clone();
        div()
            .size(px(100.))
            .track_focus(&self.focus)
            .child(crate::canvas(
                |_, _, _| (),
                move |bounds, _, window, cx| {
                    window.handle_input(
                        &focus,
                        crate::ElementInputHandler::new(bounds, entity.clone()),
                        cx,
                    );
                },
            ))
    }
}

#[test]
fn asking_a_focused_input_how_it_is_configured_does_not_change_it() {
    let mut cx = TestAppContext::single();
    let builds = Rc::new(Cell::new(0));
    let window = cx.add_window({
        let builds = builds.clone();
        move |window, cx| {
            let focus = cx.focus_handle();
            window.focus(&focus, cx);
            FocusedInput { focus, builds }
        }
    });
    backgrounds(&mut cx, window.into());
    backgrounds(&mut cx, window.into());
    let settled = builds.get();
    backgrounds(&mut cx, window.into());
    backgrounds(&mut cx, window.into());
    assert_eq!(
        builds.get(),
        settled,
        "the input is drawn from the last frame"
    );
}

struct Triangle {
    at: f32,
    builds: Rc<Cell<usize>>,
}

impl Render for Triangle {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        let at = self.at;
        div().size(px(40.)).child(
            crate::canvas(
                |_, _, _| (),
                move |bounds, _, window, _| {
                    let o = bounds.origin;
                    let mut path = crate::Path::new(o);
                    path.push_triangle(
                        (
                            o + crate::point(px(at), px(0.)),
                            o + crate::point(px(at + 20.), px(0.)),
                            o + crate::point(px(at), px(20.)),
                        ),
                        (
                            crate::point(0., 1.),
                            crate::point(0., 1.),
                            crate::point(0., 1.),
                        ),
                    );
                    window.paint_path(path, crate::black());
                },
            )
            .size_full(),
        )
    }
}

struct Triangles {
    kept: Entity<Triangle>,
    changing: Entity<Triangle>,
}

impl Render for Triangles {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .child(self.changing.clone())
            .child(self.kept.clone())
    }
}

/// The vertices of every path drawn, in drawing order.
fn path_vertices(window: &Window) -> Vec<Vec<(f32, f32)>> {
    window
        .rendered_frame
        .scene
        .paths
        .iter()
        .map(|path| {
            path.vertices
                .iter()
                .map(|v| (v.xy_position.x.0, v.xy_position.y.0))
                .collect()
        })
        .collect()
}

/// A view drawn again from the last frame still hands the renderer every
/// vertex of the paths it painted, frame after frame, while a view beside it
/// paints new ones.
#[test]
fn reused_views_keep_the_vertices_of_their_paths() {
    let mut cx = TestAppContext::single();
    let kept_builds = Rc::new(Cell::new(0));
    let window = cx.add_window({
        let kept_builds = kept_builds.clone();
        move |_, cx| Triangles {
            kept: cx.new(|_| Triangle {
                at: 5.,
                builds: kept_builds,
            }),
            changing: cx.new(|_| Triangle {
                at: 0.,
                builds: Rc::new(Cell::new(0)),
            }),
        }
    });
    let changing = window
        .update(&mut cx, |v, _, _| v.changing.clone())
        .unwrap();
    let frame = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            path_vertices(window)
        })
        .unwrap()
    };
    let first = frame(&mut cx);
    assert_eq!(first.len(), 2);
    assert!(first.iter().all(|vertices| vertices.len() == 3));
    for step in 1..5 {
        changing.update(&mut cx, |triangle, cx| {
            triangle.at = step as f32;
            cx.notify();
        });
        let drawn = frame(&mut cx);
        assert_eq!(drawn.len(), 2);
        assert_eq!(
            drawn[1], first[1],
            "frame {step}: the reused path keeps its vertices"
        );
        let scale = cx
            .update_window(window.into(), |_, window, _| window.scale_factor())
            .unwrap();
        assert_eq!(
            drawn[0][0].0 - first[0][0].0,
            step as f32 * scale,
            "frame {step}: the changed path is drawn where it moved"
        );
    }
    assert!(
        kept_builds.get() < 5,
        "the kept triangle should be drawn from the last frame at least once ({} builds)",
        kept_builds.get()
    );
}
