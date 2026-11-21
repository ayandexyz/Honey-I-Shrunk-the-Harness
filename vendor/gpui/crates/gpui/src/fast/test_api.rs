//! Keeps the `test-api` feature free of runtime cost in a real app.
//!
//! `test-api` compiles the test contexts (`TestAppContext`, `#[gpui::test]`,
//! `TestPlatform`) into GPUI, so a crate can enable it in its normal
//! dependencies and share one GPUI build between `cargo build` and
//! `cargo test`. Test-only bookkeeping, such as recording where each
//! `debug_selector` element was painted, must then not run in a real app.
//! It runs once a test app has been created in this process, which a real app
//! never does. With `test-support` (or in GPUI's own tests) it always runs, as
//! before.

use std::sync::atomic::{AtomicBool, Ordering};

static TEST_APP_CREATED: AtomicBool = AtomicBool::new(false);

/// Notes that this process runs a test app, turning test bookkeeping on.
pub(crate) fn note_test_app() {
    TEST_APP_CREATED.store(true, Ordering::Relaxed);
}

/// Whether test-only bookkeeping should run.
#[inline]
pub(crate) fn bookkeeping_enabled() -> bool {
    cfg!(any(test, feature = "test-support")) || TEST_APP_CREATED.load(Ordering::Relaxed)
}
