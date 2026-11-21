//! A `gpui::list` resized to a new width.

use crate::{
    AppContext as _, Context, Element as _, IntoElement, ListAlignment, ListOffset, ListState,
    Render, Styled as _, TestAppContext, Window, div, list, point, px, size,
};

/// Resizing invalidates every row's height, but rows off screen keep their
/// previous height as a hint rather than collapsing to 0px, so the scrollbar's
/// extent stays where it was instead of jumping and then growing row by row.
#[gpui::test]
fn test_lazy_list_keeps_height_hints_after_width_change(cx: &mut TestAppContext) {
    let cx = cx.add_empty_window();

    // Lazily measured, like a chat transcript: only visible rows render.
    let state = ListState::new(20, ListAlignment::Top, px(0.));

    struct TestView(ListState);
    impl Render for TestView {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            list(self.0.clone(), |_, _, _| {
                div().h(px(50.)).w_full().into_any()
            })
            .w_full()
            .h_full()
        }
    }

    let view = cx.update(|_, cx| cx.new(|_| TestView(state.clone())));
    // Scroll through every row once so each has a real measurement.
    for item_ix in 0..20 {
        state.scroll_to(ListOffset {
            item_ix,
            offset_in_item: px(0.),
        });
        cx.draw(point(px(0.), px(0.)), size(px(100.), px(200.)), |_, _| {
            view.clone().into_any_element()
        });
    }
    state.scroll_to(ListOffset::default());
    cx.draw(point(px(0.), px(0.)), size(px(100.), px(200.)), |_, _| {
        view.clone().into_any_element()
    });
    assert_eq!(state.max_offset_for_scrollbar().y, px(800.));

    cx.draw(point(px(0.), px(0.)), size(px(150.), px(200.)), |_, _| {
        view.into_any_element()
    });
    assert_eq!(state.max_offset_for_scrollbar().y, px(800.));
}
