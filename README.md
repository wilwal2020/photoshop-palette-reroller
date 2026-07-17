# PaletteReroller

A Photoshop (UXP) plugin panel for generating and rerolling color palettes directly onto fill layers. Pick a harmony and a style, then reroll until you find the palette you want — locking the swatches you like along the way.

## Features

- **Harmonies:** Analogous, Complementary, Split, Triadic, Tetradic, Mono (plus a Random mix mode)
- **Styles:** Default, Vibrant, Muted, Pastel, Deep
- **Per-swatch locking** so you can reroll only the colors you haven't settled on
- Works against a live set of solid-color fill layers in the active document

## Installation

The packaged plugin is included in this repo:

- `PaletteReroller.ccx` — double-click to install via Adobe Creative Cloud / the Adobe UXP Plugin Marketplace flow
- `PaletteReroller.zip` — the same package as a plain archive

Requires a version of Adobe Photoshop that supports UXP plugins.

## Development

- `main.js` — the plugin source (panel logic, harmony/style generation, batchPlay calls)

Current version: **1.6.1**
