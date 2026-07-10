# Kanban board — makepng

Vertical slices with explicit blocking relationships (DAG). Each issue is sized
to fit an agent's smart zone and is independently grabbable once unblocked.

| # | Issue                                            | Blocked by | Parallel group |
|---|--------------------------------------------------|------------|----------------|
| 1 | Scaffold: Vite+TS+Vitest, singlefile, git        | —          | A              |
| 2 | Engine: gamma.ts (sRGB↔linear LUTs)              | 1          | B              |
| 3 | Engine: chroma.ts (key color → alpha)            | 1, 2       | C              |
| 4 | Engine: adjust.ts (brightness/contrast, linear)  | 1, 2       | C              |
| 5 | Engine: transform.ts (crop/rotate/scale/size)    | 1, 2       | C              |
| 6 | UI tracer bullet: upload → canvas → download PNG | 1          | C              |
| 7 | UI: crop drag-rectangle + apply/reset            | 5, 6       | D              |
| 8 | UI: eyedropper + sensitivity/feather + preview   | 3, 6       | D              |
| 9 | UI: brightness/contrast/resize/rotate + size readout | 4, 5, 6 | D              |
| 10| Build: single-file verify + GH Actions deploy    | 1          | B              |
| 11| Review (fresh context) + QA                      | 7, 8, 9, 10| E              |
| 12| Publish: repo, push, Pages live                  | 11 + PAT   | F              |

Issues 3, 4, 5, 6 run in parallel (independent deep modules + tracer bullet).
Issues 7, 8, 9 touch main.ts — run sequentially or as one wiring pass.

## Issue details

### 2 — gamma.ts
`srgbToLinear(u8): number` in [0,1], `linearToSrgb(x): u8`, LUT-backed.
Tests: round-trip identity for all 256 values; 0→0, 255→1; midpoint ≈ 0.2159
(sRGB 128 → linear ~0.2159); encode(decode(x)) == x exactly.

### 3 — chroma.ts
`applyChromaKey(data: Uint8ClampedArray, key: [r,g,b], tolerance: number, feather: number): void`
distance in linear RGB normalized to [0,1] (divide by sqrt(3)); alpha:
0 below tol, smoothstep across feather band, opaque beyond. Multiplies into
existing alpha. Tests: exact-match pixel → alpha 0; far pixel stays; feather
monotonic; tol=0 keys only exact color; alpha of already-transparent preserved 0.

### 4 — adjust.ts
`applyBrightnessContrast(data, brightness: -1..1, contrast: -1..1): void`
linear light: `x' = clamp((x - 0.5)*(1+contrast*k) + 0.5 + brightness*m)` applied
on linear values (contrast pivot = mid-gray in linear ≈ 0.2159). Tests: identity
at (0,0); brightness raises all; contrast expands around pivot; alpha untouched.

### 5 — transform.ts
`clampRect`, `cropPixels`, `scalePixels` (gamma-correct box/bilinear),
`rotatePixels` (90° steps exact; arbitrary angle via canvas in UI, size math here),
`outputSize(w,h,{scale,rotateDeg})`. Tests: crop bounds; scale dims rounding;
rotation size for 0/90/45°; gamma-correct downscale of black/white checker → mid
gray ≈ sRGB 188 (not 128).

### 10 — deploy
`vite.config.ts` base `/makepng/`, singlefile plugin; `.github/workflows/deploy.yml`:
npm ci → test → build → upload dist → deploy-pages.
