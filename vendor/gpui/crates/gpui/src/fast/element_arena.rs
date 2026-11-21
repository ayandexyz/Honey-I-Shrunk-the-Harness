//! Sharing the element arena with GPUI copies in dynamically loaded libraries.
//!
//! An application that hot-reloads its UI from a dynamic library links a second
//! copy of GPUI into that library. Both copies must allocate elements into the
//! arena of the draw in progress, but each copy has its own thread locals. The
//! host publishes an [`ElementArenaContext`], a table of callbacks that reach its
//! own thread locals, and the library installs it, so every copy reads and sets
//! the same current arena.
//!
//! `window.rs` keeps upstream's thread locals and calls into this module for
//! every read or write of the current arena.

use std::{cell::Cell, cell::RefCell, ffi::c_void};

use crate::arena::Arena;

thread_local! {
    static INSTALLED: Cell<Option<ElementArenaContext>> = const { Cell::new(None) };
}

/// The thread-local element arena shared by a host and its dynamically loaded GPUI copies.
///
/// This table contains callbacks, not an App or an arena pointer. Each callback resolves
/// the calling thread's arena, so the table can also be installed on another thread.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ElementArenaContext {
    pub(crate) read_current: unsafe extern "C-unwind" fn() -> *const c_void,
    pub(crate) replace_current: unsafe extern "C-unwind" fn(*const c_void) -> *const c_void,
    pub(crate) fallback: unsafe extern "C-unwind" fn() -> *const c_void,
}

impl ElementArenaContext {
    /// Returns the installed canonical table, or callbacks directly accessing this
    /// GPUI copy's thread locals when no table has been installed on this thread.
    pub fn current() -> Self {
        INSTALLED.with(|context| {
            context.get().unwrap_or(Self {
                read_current: local_current,
                replace_current: local_replace_current,
                fallback: local_fallback,
            })
        })
    }

    /// Installs the canonical arena context in this GPUI copy on the calling thread.
    /// Reinstalling the same context is harmless. Install it before any plugin renders
    /// or constructs elements, and on every thread that uses the plugin's GPUI copy.
    /// An idle plugin copy may initially join a context whose host draw is active.
    ///
    /// # Safety
    ///
    /// All participating copies must use the exact same GPUI source, Rust toolchain,
    /// and build configuration affecting type layout, including `Arena`, `RefCell`,
    /// and arena-allocated element types. This is not a stable ABI between versions.
    /// The module containing the callbacks and its thread-local storage must stay
    /// loaded while this context is installed or any scopes or allocations use it.
    /// Modules containing allocated elements' code must also stay loaded until those
    /// elements have been dropped. Do not rebind this copy's active draw scopes to a
    /// different context, or change contexts while allocations from this copy's old
    /// context remain in use. The callbacks must only be used on their calling thread,
    /// never during or after teardown of that thread's GPUI thread-local storage.
    pub unsafe fn install(self) {
        INSTALLED.with(|context| context.set(Some(self)));
    }
}

#[cfg(test)]
pub(crate) fn installed() -> Option<ElementArenaContext> {
    INSTALLED.with(Cell::get)
}

#[cfg(test)]
pub(crate) fn set_installed(context: Option<ElementArenaContext>) {
    INSTALLED.with(|installed| installed.set(context));
}

unsafe extern "C-unwind" fn local_current() -> *const c_void {
    crate::window::CURRENT_ELEMENT_ARENA
        .with(|current| current.get().map_or(std::ptr::null(), |arena| arena.cast()))
}

unsafe extern "C-unwind" fn local_replace_current(arena: *const c_void) -> *const c_void {
    crate::window::CURRENT_ELEMENT_ARENA.with(|current| {
        current
            .replace((!arena.is_null()).then_some(arena.cast()))
            .map_or(std::ptr::null(), |previous| previous.cast())
    })
}

unsafe extern "C-unwind" fn local_fallback() -> *const c_void {
    crate::window::ELEMENT_ARENA.with(|arena| (arena as *const RefCell<Arena>).cast())
}

/// Whether any GPUI copy sharing this thread's context is drawing.
pub(crate) fn draw_in_progress() -> bool {
    // SAFETY: The installed table's lifetime and layout are guaranteed by install.
    unsafe { !(ElementArenaContext::current().read_current)().is_null() }
}

/// Runs `f` with the arena of the draw in progress, or this thread's fallback arena.
pub(crate) fn with_element_arena<R>(f: impl FnOnce(&mut Arena) -> R) -> R {
    let context = ElementArenaContext::current();
    // SAFETY: install guarantees compatible callbacks and arena layout. The current
    // pointer is live until its draw scope ends, and the fallback lives in this
    // thread's TLS. Neither pointer escapes this synchronous borrow.
    let arena_cell = unsafe {
        let current = (context.read_current)();
        let arena = if current.is_null() {
            (context.fallback)()
        } else {
            current
        };
        &*arena.cast::<RefCell<Arena>>()
    };
    f(&mut arena_cell.borrow_mut())
}

/// What an `ElementArenaScope` restores when it ends: the arena that was current
/// before it, through the exact table used to enter it.
pub(crate) struct PreviousArena {
    previous: *const c_void,
    context: ElementArenaContext,
}

impl PreviousArena {
    /// Makes `arena` current and remembers what it replaced.
    pub(crate) fn enter(arena: &RefCell<Arena>) -> Self {
        let context = ElementArenaContext::current();
        // SAFETY: The draw owns arena until the scope ends. install guarantees
        // that the callback accesses compatible TLS on this thread.
        let previous =
            unsafe { (context.replace_current)((arena as *const RefCell<Arena>).cast()) };
        Self { previous, context }
    }

    /// Makes the arena current before `enter` current again.
    pub(crate) fn restore(&self) {
        // SAFETY: The enclosing scope keeps the previous arena alive. Restore via
        // the exact table used to enter rather than resolving another GPUI copy.
        unsafe { (self.context.replace_current)(self.previous) };
    }
}
