//! Putting a finished scene in drawing order without moving its primitives
//! more than once or allocating, and scene helpers for tests: a finished scene
//! described as text, to compare two frames by, and forgetting the orderings
//! the bounds tree replays.

use crate::{
    MonochromeSprite, PaintSurface, Path, PolychromeSprite, Quad, ScaledPixels, Scene, Shadow,
    SubpixelSprite, Underline,
};
use std::mem;

/// Room to sort a scene's primitives in, kept from one frame to the next so
/// that a frame does not allocate megabytes to put what it drew in order.
#[derive(Default)]
pub(crate) struct SortScratch {
    order: Vec<u32>,
    shadows: Vec<Shadow>,
    quads: Vec<Quad>,
    paths: Vec<Path<ScaledPixels>>,
    underlines: Vec<Underline>,
    monochrome_sprites: Vec<MonochromeSprite>,
    subpixel_sprites: Vec<SubpixelSprite>,
    polychrome_sprites: Vec<PolychromeSprite>,
    surfaces: Vec<PaintSurface>,
    /// Where each path drawn this frame ended up after sorting, by the index
    /// it was inserted at (its [`crate::PathId`]), so a reused subtree can
    /// find the vertices its paint operations no longer hold.
    path_positions: Vec<u32>,
}

/// The path a scene draws, for `path` being inserted. Its vertices move to
/// the drawn copy, and the paint operation kept for reuse holds none: they
/// were cloned for every path drawn, and again for every path reused.
pub(crate) fn path_for_drawing(path: &mut Path<ScaledPixels>) -> Path<ScaledPixels> {
    let vertices = mem::take(&mut path.vertices);
    let mut drawn = path.clone();
    drawn.vertices = vertices;
    drawn
}

/// `primitive`, recorded in `prev_scene`, as it is drawn again. A path takes
/// back the vertices its drawn copy in `prev_scene` holds.
pub(crate) fn replayed(primitive: &crate::Primitive, prev_scene: &Scene) -> crate::Primitive {
    let mut primitive = primitive.clone();
    if let crate::Primitive::Path(path) = &mut primitive {
        let inserted = path.id.0;
        let drawn = prev_scene
            .sort_scratch
            .path_positions
            .get(inserted)
            .and_then(|&position| prev_scene.paths.get(position as usize))
            .filter(|drawn| drawn.id == path.id)
            .or_else(|| prev_scene.paths.iter().find(|drawn| drawn.id == path.id));
        if let Some(drawn) = drawn {
            path.vertices = drawn.vertices.clone();
        }
    }
    primitive
}

/// Puts `items` in the order `key` gives, keeping the order they came in
/// among equal keys, as a stable sort does.
///
/// Sorting indices and then gathering once moves each item a single time,
/// where sorting the items themselves moves them as often as the sort needs
/// to compare them — and these items are 112 to 168 bytes each.
fn sort_by_gathering<T: Clone, K: Ord>(
    items: &mut Vec<T>,
    order: &mut Vec<u32>,
    gathered: &mut Vec<T>,
    key: impl Fn(&T) -> K,
) {
    if !sort_order(items, order, key) {
        return;
    }
    gathered.clear();
    gathered.extend(order.iter().map(|&index| items[index as usize].clone()));
    mem::swap(items, gathered);
}

/// [`sort_by_gathering`] for paths, which own their vertices: each path is
/// moved into place rather than cloned, which copied every vertex of every
/// path each frame.
fn sort_paths_by_gathering(
    items: &mut Vec<Path<ScaledPixels>>,
    order: &mut Vec<u32>,
    gathered: &mut Vec<Path<ScaledPixels>>,
) {
    if !sort_order(items, order, |path| path.order) {
        return;
    }
    let mut taken: Vec<Option<Path<ScaledPixels>>> =
        mem::take(items).into_iter().map(Some).collect();
    gathered.clear();
    gathered.extend(
        order
            .iter()
            .map(|&index| taken[index as usize].take().expect("each index once")),
    );
    mem::swap(items, gathered);
}

/// Fills `order` with the indices of `items` in drawing order. Returns
/// whether that differs from the order they are in.
fn sort_order<T, K: Ord>(items: &[T], order: &mut Vec<u32>, key: impl Fn(&T) -> K) -> bool {
    if items.len() < 2 {
        return false;
    }
    order.clear();
    order.extend(0..items.len() as u32);
    order.sort_unstable_by_key(|&index| (key(&items[index as usize]), index));
    order
        .iter()
        .enumerate()
        .any(|(at, &index)| at != index as usize)
}

impl Scene {
    /// What [`Scene::finish`] does: puts every primitive in drawing order.
    /// Sprites of one order are grouped by the atlas texture they come from:
    /// a batch draws from one texture, and tile ids, which each texture
    /// numbers from zero, would interleave them.
    pub(crate) fn sort_in_drawing_order(&mut self) {
        let scratch = &mut self.sort_scratch;
        macro_rules! sort {
            ($field:ident, $key:expr) => {
                sort_by_gathering(
                    &mut self.$field,
                    &mut scratch.order,
                    &mut scratch.$field,
                    $key,
                )
            };
        }
        sort!(shadows, |shadow: &Shadow| shadow.order);
        sort!(quads, |quad: &Quad| quad.order);
        sort_paths_by_gathering(&mut self.paths, &mut scratch.order, &mut scratch.paths);
        scratch.path_positions.clear();
        scratch.path_positions.resize(self.paths.len(), u32::MAX);
        for (position, path) in self.paths.iter().enumerate() {
            if let Some(slot) = scratch.path_positions.get_mut(path.id.0) {
                *slot = position as u32;
            }
        }
        sort!(underlines, |underline: &Underline| underline.order);
        sort!(monochrome_sprites, |sprite: &MonochromeSprite| (
            sprite.order,
            sprite.tile.texture_id.index,
            sprite.tile.tile_id
        ));
        sort!(subpixel_sprites, |sprite: &SubpixelSprite| (
            sprite.order,
            sprite.tile.texture_id.index,
            sprite.tile.tile_id
        ));
        sort!(polychrome_sprites, |sprite: &PolychromeSprite| (
            sprite.order,
            sprite.tile.texture_id.index,
            sprite.tile.tile_id
        ));
        sort!(surfaces, |surface: &PaintSurface| surface.order);
    }

    /// Forgets the orderings recorded for replaying, so the next frame orders
    /// every primitive from scratch.
    #[cfg(test)]
    pub(crate) fn forget_orderings(&mut self) {
        self.primitive_bounds.forget();
    }

    /// Everything this finished scene draws, in drawing order, as text two
    /// scenes can be compared by: each primitive with its bounds, clip, colours
    /// and ordering, and each layer's bounds. Atlas tiles are left out, since
    /// two windows need not place the same glyph in the same tile.
    #[cfg(test)]
    pub(crate) fn describe(&self) -> Vec<String> {
        let mut lines = Vec::new();
        for operation in &self.paint_operations {
            match operation {
                crate::PaintOperation::StartLayer(bounds) => {
                    lines.push(format!("layer {bounds:?}"))
                }
                crate::PaintOperation::EndLayer => lines.push("end layer".into()),
                crate::PaintOperation::Primitive(..) => {}
            }
        }
        lines.extend(self.shadows.iter().map(|shadow| format!("{shadow:?}")));
        lines.extend(self.quads.iter().map(|quad| format!("{quad:?}")));
        lines.extend(
            self.underlines
                .iter()
                .map(|underline| format!("{underline:?}")),
        );
        lines.extend(self.monochrome_sprites.iter().map(|sprite| {
            format!(
                "monochrome sprite {} {:?} {:?} {:?}",
                sprite.order, sprite.bounds, sprite.content_mask, sprite.color
            )
        }));
        lines.extend(self.subpixel_sprites.iter().map(|sprite| {
            format!(
                "subpixel sprite {} {:?} {:?} {:?}",
                sprite.order, sprite.bounds, sprite.content_mask, sprite.color
            )
        }));
        lines.extend(self.polychrome_sprites.iter().map(|sprite| {
            format!(
                "polychrome sprite {} {:?} {:?}",
                sprite.order, sprite.bounds, sprite.content_mask
            )
        }));
        lines.extend(
            self.paths
                .iter()
                .map(|path| format!("path {} {:?}", path.order, path.bounds)),
        );
        lines
    }
}
