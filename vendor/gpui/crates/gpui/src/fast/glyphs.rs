//! Glyph painting that works out a run's rendering once, not once a glyph.

use crate::{
    Bounds, ContentMask, FontId, GlyphId, Hsla, IsZero, MonochromeSprite, Pixels, Point,
    RenderGlyphParams, SUBPIXEL_VARIANTS_X, SUBPIXEL_VARIANTS_Y, ScaledPixels, SubpixelSprite,
    TransformationMatrix, Window, util::round_half_toward_zero,
};
use anyhow::Result;
use std::borrow::Cow;

/// How the glyphs of a run are rendered: what painting a glyph needs that
/// depends on its run, not on the glyph. See [`Window::glyph_run_rendering`].
#[derive(Clone, Copy, PartialEq)]
pub(crate) struct GlyphRunRendering {
    subpixel_rendering: bool,
    dilation: u8,
}

impl Window {
    /// How the glyphs of a run in `font_id` at `font_size` and in `color` are
    /// rendered, which [`Window::paint_glyph_in_run`] takes so that painting a
    /// line works it out once a run rather than once a glyph: it asks the
    /// window how it is drawn and converts the colour to find its dilation.
    pub(crate) fn glyph_run_rendering(
        &self,
        font_id: FontId,
        font_size: Pixels,
        color: Hsla,
    ) -> GlyphRunRendering {
        GlyphRunRendering {
            subpixel_rendering: self.should_use_subpixel_rendering(font_id, font_size),
            dilation: self.text_system().glyph_dilation_for_color(color),
        }
    }

    /// [`Window::paint_glyph`], for a glyph in a run whose rendering and
    /// snapped content mask the caller has already worked out.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn paint_glyph_in_run(
        &mut self,
        origin: Point<Pixels>,
        font_id: FontId,
        glyph_id: GlyphId,
        font_size: Pixels,
        color: Hsla,
        rendering: GlyphRunRendering,
        content_mask: ContentMask<ScaledPixels>,
    ) -> Result<()> {
        self.invalidator.debug_assert_paint();

        let element_opacity = self.element_opacity();
        let scale_factor = self.scale_factor();
        let glyph_origin = origin.scale(scale_factor);

        let quantized_origin = Point::new(
            round_half_toward_zero(glyph_origin.x.0 * SUBPIXEL_VARIANTS_X as f32)
                / SUBPIXEL_VARIANTS_X as f32,
            round_half_toward_zero(glyph_origin.y.0 * SUBPIXEL_VARIANTS_Y as f32)
                / SUBPIXEL_VARIANTS_Y as f32,
        );
        let subpixel_variant = Point::new(
            (quantized_origin.x.fract() * SUBPIXEL_VARIANTS_X as f32) as u8,
            (quantized_origin.y.fract() * SUBPIXEL_VARIANTS_Y as f32) as u8,
        );
        let integer_origin = quantized_origin.map(|c| ScaledPixels(c.trunc()));
        let GlyphRunRendering {
            subpixel_rendering,
            dilation,
        } = rendering;
        let params = RenderGlyphParams {
            font_id,
            glyph_id,
            font_size,
            subpixel_variant,
            scale_factor,
            is_emoji: false,
            subpixel_rendering,
            dilation,
        };

        let raster_bounds = self.text_system().raster_bounds(&params)?;
        if !raster_bounds.is_zero() {
            let tile = self
                .sprite_atlas
                .get_or_insert_with(&params.clone().into(), &mut || {
                    let (size, bytes) = self.text_system().rasterize_glyph(&params)?;
                    Ok(Some((size, Cow::Owned(bytes))))
                })?
                .expect("Callback above only errors or returns Some");
            let bounds = Bounds {
                origin: integer_origin + raster_bounds.origin.map(Into::into),
                size: tile.bounds.size.map(Into::into),
            };

            if subpixel_rendering {
                self.next_frame.scene.insert_primitive(SubpixelSprite {
                    order: 0,
                    pad: 0,
                    bounds,
                    content_mask,
                    color: color.opacity(element_opacity),
                    tile,
                    transformation: TransformationMatrix::unit(),
                });
            } else {
                self.next_frame.scene.insert_primitive(MonochromeSprite {
                    order: 0,
                    pad: 0,
                    bounds,
                    content_mask,
                    color: color.opacity(element_opacity),
                    tile,
                    transformation: TransformationMatrix::unit(),
                });
            }
        }
        Ok(())
    }
}

/// Paints the glyphs of a line, working out what they share once rather than
/// once a glyph: the snapped content mask, which nothing painted along a line
/// changes, and the rendering of each run, which only changes with the run's
/// font or color.
pub(crate) struct LineGlyphPainter {
    snapped_content_mask: ContentMask<ScaledPixels>,
    run_rendering: Option<(FontId, Hsla, GlyphRunRendering)>,
}

impl LineGlyphPainter {
    pub(crate) fn new(window: &Window) -> Self {
        Self {
            snapped_content_mask: window.snapped_content_mask(),
            run_rendering: None,
        }
    }

    /// [`Window::paint_glyph`], for the next glyph of the line.
    pub(crate) fn paint_glyph(
        &mut self,
        window: &mut Window,
        origin: Point<Pixels>,
        font_id: FontId,
        glyph_id: GlyphId,
        font_size: Pixels,
        color: Hsla,
    ) -> Result<()> {
        let rendering = match self.run_rendering {
            Some((run_font_id, run_color, rendering))
                if run_font_id == font_id && run_color == color =>
            {
                rendering
            }
            _ => {
                let rendering = window.glyph_run_rendering(font_id, font_size, color);
                self.run_rendering = Some((font_id, color, rendering));
                rendering
            }
        };
        window.paint_glyph_in_run(
            origin,
            font_id,
            glyph_id,
            font_size,
            color,
            rendering,
            self.snapped_content_mask,
        )
    }
}
