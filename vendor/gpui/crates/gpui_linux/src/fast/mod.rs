//! What gpui-fast adds to gpui_linux; see crates/gpui/src/fast/mod.rs.

#[cfg(any(feature = "wayland", feature = "x11"))]
pub(crate) mod pinch;
