# makepng

Single-page web app that turns any image into a transparent PNG — entirely in
your browser, no uploads to any server.

**Live: https://heios.github.io/makepng**

Flow: drop/paste an image → drag-select a crop region → click the color to
remove (eyedropper) → tune sensitivity & feather → adjust brightness, contrast,
rotation, size (final dimensions computed live) → download PNG.

## Color science

Images store sRGB gamma-encoded values (≈ sqrt of linear light). All pixel
math here — color distance, feathering, brightness/contrast, resampling,
rotation — decodes to linear light (≈ squaring), operates there, and re-encodes
(≈ sqrt), using exact sRGB transfer functions backed by lookup tables. That's
why a black/white checker downscales to sRGB 188, not 128 — and why edges stay
clean.

## Development

```
npm install
npm test        # Vitest — 51 tests over the pure engine modules
npm run dev     # Vite dev server
npm run build   # tsc --noEmit + single-file dist/index.html (no runtime deps)
```

Architecture: deep, pure engine modules (`src/engine/{gamma,chroma,adjust,transform}.ts`)
unit-tested on raw pixel buffers, plus a thin canvas UI (`src/main.ts`).
Built with a TDD, agentic workflow — see `docs/PRD.md` and `docs/issues/BOARD.md`.

Deploys automatically to GitHub Pages on every push to `main`.
