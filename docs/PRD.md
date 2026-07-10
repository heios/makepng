# PRD — makepng

Single-page web app that turns any image into a transparent PNG. Deployed as one
self-contained static `index.html` at https://heios.github.io/makepng.

## Problem

Removing a flat background color from an image (logo, scan, sticker, screenshot)
normally requires a heavy editor. Users want: open page → drop image → crop →
click background color → tune sensitivity → download PNG with alpha.

## User flow

1. **Upload** — file input + drag-and-drop + paste. Any browser-decodable image.
2. **Crop** — drag a rectangle over the image; apply crop; reset available.
3. **Pick color** — eyedropper: click the image to choose the key color (swatch shown).
4. **Tune** — sliders:
   - *Sensitivity* (tolerance): how far from the key color a pixel may be and still become transparent.
   - *Feather*: soft alpha falloff band beyond the tolerance edge (no hard cutoff).
   - *Brightness*, *Contrast*: applied in linear light.
   - *Resize* (scale %): output dimensions recalculated on the fly and displayed.
   - *Rotate* (degrees).
5. **Preview** — live result on a checkerboard background; updates as sliders move.
6. **Download** — final PNG at output resolution.

## Color science (core requirement)

Images store sRGB **gamma-encoded** values (≈ linear^(1/2.2), close to sqrt of
linear light). All pixel math — color distance, feather interpolation,
brightness/contrast, resampling — must be done in **linear light**:
decode sRGB→linear (≈ squaring), operate, re-encode linear→sRGB (≈ sqrt).
Implementation uses the exact sRGB transfer functions with lookup tables
(decode: 256-entry LUT; encode: 4096-entry LUT) for speed.

Color distance: Euclidean in linear RGB, normalized to [0,1].
Alpha map: `d <= tol → 0`; `d >= tol+feather → 255`; smoothstep between.

## Architecture (deep modules)

Pure engine modules, each a deep module with a small interface, unit-tested with
Vitest on raw `Uint8ClampedArray` pixel buffers (no DOM needed):

- `src/engine/gamma.ts` — sRGB↔linear LUTs and converters.
- `src/engine/chroma.ts` — `applyChromaKey(pixels, key, tolerance, feather)`.
- `src/engine/adjust.ts` — `applyBrightnessContrast(pixels, brightness, contrast)` in linear light.
- `src/engine/transform.ts` — crop rect math, rotation of buffers, gamma-correct
  scaling, `outputSize(w, h, scale, rotate)` for the live size readout.
- `src/main.ts` — thin UI layer: canvas rendering, pointer interactions, sliders,
  debounced pipeline run, PNG export via `canvas.toBlob`.

Pipeline order: crop → rotate → scale → brightness/contrast → chroma key → encode PNG.

## Non-goals

Multiple key colors, magic-wand region selection, undo history, server side.

## Quality bar

- TDD: every engine function gets failing tests first (red-green-refactor).
- `tsc --noEmit` clean under `strict`.
- `vite build` + `vite-plugin-singlefile` → single `dist/index.html`, no runtime deps.
- Deploy: GitHub Actions → GitHub Pages on push to `main`.

## Acceptance criteria

- 4000×3000 photo processes with visibly live slider response (≤ ~150 ms per update at preview resolution; full resolution used for download).
- White-background logo keyed on white at defaults yields transparent corners, intact interior.
- Feather 0 gives hard edge; feather > 0 gives monotonic alpha ramp.
- Output size readout always matches downloaded PNG dimensions.
