//! The element arena shared with GPUI copies in dynamically loaded libraries.
use std::{
    cell::{Cell, RefCell},
    panic::AssertUnwindSafe,
    rc::Rc,
};

use crate::{
    App, ElementArenaContext, TestAppContext,
    arena::Arena,
    fast::element_arena::{draw_in_progress, installed, set_installed, with_element_arena},
    window::{CURRENT_ELEMENT_ARENA, ElementArenaScope},
};

thread_local! {
    static FOREIGN_CURRENT: Cell<*const std::ffi::c_void> = const { Cell::new(std::ptr::null()) };
    static FOREIGN_FALLBACK: RefCell<Arena> = RefCell::new(Arena::new(1024));
}

unsafe extern "C-unwind" fn foreign_current() -> *const std::ffi::c_void {
    FOREIGN_CURRENT.with(Cell::get)
}

unsafe extern "C-unwind" fn foreign_replace(
    arena: *const std::ffi::c_void,
) -> *const std::ffi::c_void {
    FOREIGN_CURRENT.with(|current| current.replace(arena))
}

unsafe extern "C-unwind" fn foreign_fallback() -> *const std::ffi::c_void {
    FOREIGN_FALLBACK.with(|arena| (arena as *const RefCell<Arena>).cast())
}

fn foreign_context() -> ElementArenaContext {
    ElementArenaContext {
        read_current: foreign_current,
        replace_current: foreign_replace,
        fallback: foreign_fallback,
    }
}

struct RestoreContext(Option<ElementArenaContext>);

impl RestoreContext {
    fn install(context: ElementArenaContext) -> Self {
        let previous = installed();
        // SAFETY: Tests use the same GPUI implementation and static callbacks,
        // and restore the table only after all scopes and allocations end.
        unsafe { context.install() };
        Self(previous)
    }
}

impl Drop for RestoreContext {
    fn drop(&mut self) {
        set_installed(self.0);
    }
}

struct DropProbe(Rc<Cell<usize>>);

impl Drop for DropProbe {
    fn drop(&mut self) {
        self.0.set(self.0.get() + 1);
    }
}

fn allocate_probe(drops: &Rc<Cell<usize>>) -> crate::arena::ArenaBox<DropProbe> {
    with_element_arena(|arena| arena.alloc(|| DropProbe(drops.clone())))
}

fn exit_and_clear(scope: ElementArenaScope, arena: &RefCell<Arena>) {
    let _clear = scope.exit(arena);
    arena.borrow_mut().clear();
}

#[test]
fn test_element_arena_context_local_and_idempotent_install() {
    let context = ElementArenaContext::current();
    let _restore = RestoreContext::install(context);
    let arena = RefCell::new(Arena::new(1024));
    let scope = ElementArenaScope::enter(&arena);
    let drops = Rc::new(Cell::new(0));
    let allocation = allocate_probe(&drops);
    for _ in 0..4 {
        // SAFETY: Reinstalling the exact same canonical context is permitted.
        unsafe { ElementArenaContext::current().install() };
        assert!(draw_in_progress());
        assert!(Rc::ptr_eq(&allocation.0, &drops));
    }
    exit_and_clear(scope, &arena);
    assert!(!draw_in_progress());
    assert_eq!(drops.get(), 1);
}

#[test]
fn test_element_arena_context_foreign_fallback_and_scope() {
    let _restore = RestoreContext::install(foreign_context());
    let fallback_drops = Rc::new(Cell::new(0));
    let fallback_allocation = allocate_probe(&fallback_drops);
    assert!(!draw_in_progress());
    FOREIGN_FALLBACK.with(|arena| {
        with_element_arena(|current| assert!(std::ptr::eq(current, arena.as_ptr())));
    });
    let arena = RefCell::new(Arena::new(1024));
    let scope = ElementArenaScope::enter(&arena);
    CURRENT_ELEMENT_ARENA.with(|current| assert!(current.get().is_none()));
    // SAFETY: current must return the foreign table itself, not forwarding
    // callbacks that would recurse after installing the returned table.
    unsafe { ElementArenaContext::current().install() };
    assert!(draw_in_progress());
    let drops = Rc::new(Cell::new(0));
    let allocation = allocate_probe(&drops);
    assert!(Rc::ptr_eq(&allocation.0, &drops));
    exit_and_clear(scope, &arena);
    assert_eq!(drops.get(), 1);
    assert_eq!(fallback_drops.get(), 0);
    assert!(Rc::ptr_eq(&fallback_allocation.0, &fallback_drops));
    FOREIGN_FALLBACK.with_borrow_mut(Arena::clear);
    assert_eq!(fallback_drops.get(), 1);
    assert!(!draw_in_progress());
}

#[test]
fn test_element_arena_context_plugin_joins_active_host_draw() {
    let arena = RefCell::new(Arena::new(1024));
    let drops = Rc::new(Cell::new(0));
    // Simulate the host copy entering its draw before the plugin has installed
    // anything. In particular, do not use the plugin's scope entry path here.
    arena.borrow_mut().begin_scope();
    let previous =
        FOREIGN_CURRENT.with(|current| current.replace((&arena as *const RefCell<Arena>).cast()));
    assert!(!draw_in_progress());
    let _restore = RestoreContext::install(foreign_context());
    assert!(draw_in_progress());
    CURRENT_ELEMENT_ARENA.with(|current| assert!(current.get().is_none()));
    let allocation = allocate_probe(&drops);
    assert!(Rc::ptr_eq(&allocation.0, &drops));
    with_element_arena(|current| assert!(std::ptr::eq(current, arena.as_ptr())));
    FOREIGN_CURRENT.with(|current| current.set(previous));
    arena.borrow_mut().end_scope();
    arena.borrow_mut().clear();
    assert_eq!(drops.get(), 1);
    assert!(!draw_in_progress());
}

#[test]
fn test_element_arena_context_nested_same_arena_defers_cleanup() {
    let _restore = RestoreContext::install(foreign_context());
    let arena = RefCell::new(Arena::new(1024));
    let drops = Rc::new(Cell::new(0));
    let outer = ElementArenaScope::enter(&arena);
    let outer_allocation = allocate_probe(&drops);
    let inner = ElementArenaScope::enter(&arena);
    let inner_allocation = allocate_probe(&drops);
    exit_and_clear(inner, &arena);
    assert!(draw_in_progress());
    assert_eq!(drops.get(), 0);
    assert!(Rc::ptr_eq(&outer_allocation.0, &inner_allocation.0));
    exit_and_clear(outer, &arena);
    assert_eq!(drops.get(), 2);
    assert!(!draw_in_progress());
}

#[test]
fn test_element_arena_context_nested_different_arenas_restore_parent() {
    let _restore = RestoreContext::install(foreign_context());
    let first_arena = RefCell::new(Arena::new(1024));
    let second_arena = RefCell::new(Arena::new(1024));
    let first_drops = Rc::new(Cell::new(0));
    let second_drops = Rc::new(Cell::new(0));
    let outer = ElementArenaScope::enter(&first_arena);
    let outer_allocation = allocate_probe(&first_drops);
    let inner = ElementArenaScope::enter(&second_arena);
    let inner_allocation = allocate_probe(&second_drops);
    assert!(Rc::ptr_eq(&inner_allocation.0, &second_drops));
    exit_and_clear(inner, &second_arena);
    assert_eq!(second_drops.get(), 1);
    assert_eq!(first_drops.get(), 0);
    assert!(Rc::ptr_eq(&outer_allocation.0, &first_drops));
    with_element_arena(|current| assert!(std::ptr::eq(current, first_arena.as_ptr())));
    let restored_allocation = allocate_probe(&first_drops);
    assert!(Rc::ptr_eq(&restored_allocation.0, &first_drops));
    exit_and_clear(outer, &first_arena);
    assert_eq!(first_drops.get(), 2);
    assert!(!draw_in_progress());
}

#[test]
fn test_element_arena_context_panic_restores_parent_and_scope_depth() {
    let _restore = RestoreContext::install(foreign_context());
    let arena = RefCell::new(Arena::new(1024));
    let drops = Rc::new(Cell::new(0));
    let outer = ElementArenaScope::enter(&arena);
    let allocation = allocate_probe(&drops);
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let _inner = ElementArenaScope::enter(&arena);
        let _allocation = allocate_probe(&drops);
        panic!("unwind a nested draw");
    }));
    assert!(result.is_err());
    assert!(draw_in_progress());
    arena.borrow_mut().clear();
    assert_eq!(drops.get(), 0);
    assert!(Rc::ptr_eq(&allocation.0, &drops));
    exit_and_clear(outer, &arena);
    assert_eq!(drops.get(), 2);
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let _scope = ElementArenaScope::enter(&arena);
        let _allocation = allocate_probe(&drops);
        panic!("unwind an outer draw");
    }));
    assert!(result.is_err());
    assert!(!draw_in_progress());
    arena.borrow_mut().clear();
    assert_eq!(drops.get(), 3);
}

#[gpui::test]
fn test_element_arena_context_multiple_apps(
    first: &mut TestAppContext,
    second: &mut TestAppContext,
) {
    let _restore = RestoreContext::install(foreign_context());
    let first_drops = Rc::new(Cell::new(0));
    let second_drops = Rc::new(Cell::new(0));
    first.update(|first| {
        let outer = ElementArenaScope::enter(&first.element_arena);
        let allocation = allocate_probe(&first_drops);
        second.update(|second| {
            let inner = ElementArenaScope::enter(&second.element_arena);
            let allocation = allocate_probe(&second_drops);
            assert!(Rc::ptr_eq(&allocation.0, &second_drops));
            inner.exit(&second.element_arena).clear(second);
        });
        assert_eq!(second_drops.get(), 1);
        assert_eq!(first_drops.get(), 0);
        assert!(Rc::ptr_eq(&allocation.0, &first_drops));
        with_element_arena(|current| {
            assert!(std::ptr::eq(current, first.element_arena.as_ptr()));
        });
        outer.exit(&first.element_arena).clear(first);
    });
    assert_eq!(first_drops.get(), 1);
    assert!(!draw_in_progress());
}

#[gpui::test]
fn test_element_arena_context_many_frames_have_bounded_capacity(cx: &mut App) {
    let _restore = RestoreContext::install(foreign_context());
    let drops = Rc::new(Cell::new(0));
    let initial_capacity = cx.element_arena.borrow().capacity();
    let fallback_capacity = FOREIGN_FALLBACK.with_borrow(Arena::capacity);
    for frame in 0..256 {
        let scope = ElementArenaScope::enter(&cx.element_arena);
        for _ in 0..128 {
            let allocation = allocate_probe(&drops);
            assert!(Rc::ptr_eq(&allocation.0, &drops));
        }
        assert_eq!(drops.get(), frame * 128);
        scope.exit(&cx.element_arena).clear(cx);
        assert_eq!(drops.get(), (frame + 1) * 128);
        assert_eq!(cx.element_arena.borrow().capacity(), initial_capacity);
        assert_eq!(
            FOREIGN_FALLBACK.with_borrow(Arena::capacity),
            fallback_capacity
        );
        assert!(!draw_in_progress());
    }
}

#[test]
fn test_element_arena_context_installation_and_arenas_are_thread_local() {
    let _restore = RestoreContext::install(foreign_context());
    let context = ElementArenaContext::current();
    let arena = RefCell::new(Arena::new(1024));
    let scope = ElementArenaScope::enter(&arena);
    let parent_fallback = FOREIGN_FALLBACK.with(|arena| arena as *const _ as usize);
    let child = std::thread::spawn(move || {
        assert!(installed().is_none());
        assert!(!draw_in_progress());
        let _restore = RestoreContext::install(context);
        assert!(!draw_in_progress());
        assert_ne!(
            FOREIGN_FALLBACK.with(|arena| arena as *const _ as usize),
            parent_fallback
        );
        let child_arena = RefCell::new(Arena::new(1024));
        let child_scope = ElementArenaScope::enter(&child_arena);
        let drops = Rc::new(Cell::new(0));
        let allocation = allocate_probe(&drops);
        assert!(Rc::ptr_eq(&allocation.0, &drops));
        exit_and_clear(child_scope, &child_arena);
        assert_eq!(drops.get(), 1);
        assert!(!draw_in_progress());
    });
    if let Err(panic) = child.join() {
        std::panic::resume_unwind(panic);
    }
    assert!(draw_in_progress());
    with_element_arena(|current| assert!(std::ptr::eq(current, arena.as_ptr())));
    exit_and_clear(scope, &arena);
    assert!(!draw_in_progress());
}
