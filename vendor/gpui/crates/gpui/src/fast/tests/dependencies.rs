//! Tests of how retained subtrees record what they read. See
//! [`crate::fast::dependencies`].

use crate::fast::dependencies::merge_sorted;
use std::rc::Rc;

#[test]
fn merging_sorted_lists_shares_one_that_holds_the_other() {
    let all: Rc<[u32]> = Rc::from([1, 3, 5, 7]);
    let some: Rc<[u32]> = Rc::from([3, 7]);
    let empty: Rc<[u32]> = Rc::from([]);

    assert!(Rc::ptr_eq(&merge_sorted(&all, &some), &all));
    assert!(Rc::ptr_eq(&merge_sorted(&some, &all), &all));
    assert!(Rc::ptr_eq(&merge_sorted(&all, &empty), &all));
    assert!(Rc::ptr_eq(&merge_sorted(&empty, &some), &some));

    let other: Rc<[u32]> = Rc::from([2, 3, 8]);
    assert_eq!(&*merge_sorted(&all, &other), &[1, 2, 3, 5, 7, 8]);
    assert_eq!(&*merge_sorted(&other, &all), &[1, 2, 3, 5, 7, 8]);
}

/// While a view is drawn, its own updates are part of drawing it; updates to
/// anything else are writes that change what other views read.
#[test]
fn only_updates_to_views_being_drawn_are_not_writes() {
    use crate::{AppContext as _, TestAppContext};
    let mut cx = TestAppContext::single();
    cx.update(|cx| {
        let drawn = cx.new(|_| 0u32);
        let other = cx.new(|_| 0u32);
        let start = cx.entities.begin_recording();
        cx.entities
            .access_log
            .drawing_views
            .borrow_mut()
            .push(drawn.entity_id());
        let before = cx.entities.write_generation();
        drawn.update(cx, |value, _| *value += 1);
        assert_eq!(cx.entities.write_generation(), before, "drawing itself");
        other.update(cx, |value, _| *value += 1);
        assert_eq!(
            cx.entities.write_generation(),
            before + 1,
            "writing another"
        );
        cx.entities.access_log.drawing_views.borrow_mut().pop();
        cx.entities.finish_recording(start);
    });
}
