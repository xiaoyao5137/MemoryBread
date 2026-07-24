# MemoryBread L4 light logo candidate

This folder contains the refined light version of the selected L4 direction. It is a design candidate only; no existing application, DMG, client, or website icon has been replaced.

## Design decisions

- Preserve the modular Chinese `记` construction from L4.
- Replace the upper-left orange block with a compact bread-slice silhouette: domed crown, subtle shoulders, short straight sides, and a softly rounded flat base.
- Use a warm ivory application tile with a cocoa-brown glyph and baking-orange bread accent.
- Use two flat brand colors for the transparent mark so it stays clean on both light and dark UI surfaces.

Brand colors:

- Warm ivory: `#FFF4DF`
- Deep cocoa: `#43281F`
- Baking orange: `#F0782D`

## Files

- `memorybread-l4-light-app-icon.png`: master light application-icon concept, 1254×1254 RGB.
- `memorybread-l4-mark-transparent.png`: master standalone brand mark, 1254×1254 RGBA.
- `sizes/app-icon-*.png`: 1024, 512, 128, and 64 px application-icon previews.
- `sizes/brand-mark-*.png`: 512, 256, and 64 px transparent brand-mark exports.
- `source/memorybread-l4-mark-chroma.png`: chroma-key source retained for provenance.

Recommended use after approval:

- Software/DMG/client application icon: light application tile.
- Client navigation, splash screen, website header, and favicon source: transparent brand mark.

## Generation record

Generation mode: built-in `image_gen` image edit/generation.

Light application-icon prompt:

> Refine the provided MemoryBread L4 icon while preserving its exact modular `记` composition and proportions. Replace only the upper-left orange rounded square with a tiny, solid bread-slice silhouette: domed top, subtle inward shoulders, short straight sides, flat softly rounded bottom, and no internal details. Create a light version on a warm ivory rounded-square tile (`#FFF4DF`), with the main glyph in deep cocoa (`#43281F`) and the bread accent in baking orange (`#F0782D`). Keep the symbol centered, geometric, friendly, high-contrast, and readable at small application-icon sizes. No text, no mockup, no extra decorations.

Standalone-mark prompt:

> Isolate the exact refined MemoryBread mark from the supplied light icon and glyph reference. Preserve the correct modular Chinese `记` construction and the small bread-slice silhouette in the upper-left. Remove the rounded-square tile and place the mark alone on a perfectly flat bright-green chroma background. Keep generous square padding, crisp geometry, and no shadows, texture, text, or additional elements. The dark glyph should remain cocoa brown and the bread should remain baking orange.

The chroma background was removed locally. The transparent master was then normalized to the two flat brand colors while preserving anti-aliased alpha edges. Transparent size exports use alpha-aware resizing.

Before production use, the approved geometry should be rebuilt as deterministic vector artwork and exported to platform-specific formats such as SVG, ICNS, and ICO.
