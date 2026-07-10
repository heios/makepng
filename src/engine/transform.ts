/**
 * Geometry ops on RGBA pixel buffers: crop, scale, rotate.
 *
 * All resampling happens in linear light (via gamma.ts) on alpha-premultiplied
 * values, so averages are physically correct and transparent pixels never
 * bleed their (meaningless) color into neighbors. Multiples of 90° rotate by
 * exact index remapping — zero resampling loss.
 */

import { srgbToLinear, linearToSrgb } from './gamma';

export interface Rect { x: number; y: number; w: number; h: number }
export interface Pixels { data: Uint8ClampedArray; w: number; h: number } // RGBA

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Integer-snap and clamp a rect into [0,w)×[0,h), minimum size 1×1.
 * Edges are rounded independently (the rect is treated as a region and
 * intersected with the bounds), so a negative origin shrinks the rect
 * rather than sliding it.
 */
export function clampRect(r: Rect, w: number, h: number): Rect {
  const x0 = clampNum(Math.round(r.x), 0, Math.max(0, w - 1));
  const y0 = clampNum(Math.round(r.y), 0, Math.max(0, h - 1));
  const x1 = clampNum(Math.round(r.x + r.w), x0 + 1, w);
  const y1 = clampNum(Math.round(r.y + r.h), y0 + 1, h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Copy a sub-rect (assumed already clamped) into a fresh buffer. */
export function cropPixels(src: Pixels, r: Rect): Pixels {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const srcOff = ((r.y + y) * src.w + r.x) * 4;
    out.set(src.data.subarray(srcOff, srcOff + r.w * 4), y * r.w * 4);
  }
  return { data: out, w: r.w, h: r.h };
}

/** Decode sRGB bytes to a Float64 premultiplied-linear buffer [r·a, g·a, b·a, a]. */
function toPremulLinear(src: Pixels): Float64Array {
  const n = src.w * src.h;
  const buf = new Float64Array(n * 4);
  const d = src.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = (d[o + 3] as number) / 255;
    buf[o] = srgbToLinear(d[o] as number) * a;
    buf[o + 1] = srgbToLinear(d[o + 1] as number) * a;
    buf[o + 2] = srgbToLinear(d[o + 2] as number) * a;
    buf[o + 3] = a;
  }
  return buf;
}

/** Unpremultiply and encode a premultiplied-linear buffer back to sRGB bytes. */
function fromPremulLinear(buf: Float64Array, w: number, h: number): Pixels {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const a = buf[o + 3] as number;
    if (a > 1e-12) {
      out[o] = linearToSrgb((buf[o] as number) / a);
      out[o + 1] = linearToSrgb((buf[o + 1] as number) / a);
      out[o + 2] = linearToSrgb((buf[o + 2] as number) / a);
      out[o + 3] = Math.round(clampNum(a, 0, 1) * 255);
    }
    // else: leave fully transparent black (already zeroed)
  }
  return { data: out, w, h };
}

/**
 * Resample one axis of a premultiplied-linear buffer.
 * Downscale: exact fractional-coverage box filter. Upscale: bilinear with
 * edge clamping. Strides let the same code run horizontally or vertically.
 */
function resampleAxis(
  src: Float64Array,
  srcLen: number,
  lines: number,
  dstLen: number,
  srcAxisStride: number,
  srcLineStride: number,
  dstAxisStride: number,
  dstLineStride: number,
): Float64Array {
  const dst = new Float64Array(dstLen * lines * 4);
  if (dstLen < srcLen) {
    // Box filter: each destination pixel averages its exact source coverage.
    const scale = srcLen / dstLen;
    for (let line = 0; line < lines; line++) {
      const sBase = line * srcLineStride;
      const dBase = line * dstLineStride;
      for (let j = 0; j < dstLen; j++) {
        const s0 = j * scale;
        const s1 = s0 + scale;
        let r = 0, g = 0, b = 0, a = 0;
        const iEnd = Math.min(Math.ceil(s1), srcLen);
        for (let i = Math.floor(s0); i < iEnd; i++) {
          const cov = Math.min(i + 1, s1) - Math.max(i, s0);
          const o = sBase + i * srcAxisStride;
          r += (src[o] as number) * cov;
          g += (src[o + 1] as number) * cov;
          b += (src[o + 2] as number) * cov;
          a += (src[o + 3] as number) * cov;
        }
        const d = dBase + j * dstAxisStride;
        dst[d] = r / scale;
        dst[d + 1] = g / scale;
        dst[d + 2] = b / scale;
        dst[d + 3] = a / scale;
      }
    }
  } else {
    // Bilinear: sample between the two nearest source centers, clamped at edges.
    for (let line = 0; line < lines; line++) {
      const sBase = line * srcLineStride;
      const dBase = line * dstLineStride;
      for (let j = 0; j < dstLen; j++) {
        const s = ((j + 0.5) * srcLen) / dstLen - 0.5;
        const i0 = Math.floor(s);
        const f = s - i0;
        const o0 = sBase + clampNum(i0, 0, srcLen - 1) * srcAxisStride;
        const o1 = sBase + clampNum(i0 + 1, 0, srcLen - 1) * srcAxisStride;
        const d = dBase + j * dstAxisStride;
        dst[d] = (src[o0] as number) * (1 - f) + (src[o1] as number) * f;
        dst[d + 1] = (src[o0 + 1] as number) * (1 - f) + (src[o1 + 1] as number) * f;
        dst[d + 2] = (src[o0 + 2] as number) * (1 - f) + (src[o1 + 2] as number) * f;
        dst[d + 3] = (src[o0 + 3] as number) * (1 - f) + (src[o1 + 3] as number) * f;
      }
    }
  }
  return dst;
}

/**
 * Gamma-correct resample to exactly dstW×dstH (each ≥ 1). Separable:
 * horizontal pass then vertical, each choosing box (shrink) or bilinear
 * (grow) independently. Identity sizes short-circuit to a byte copy.
 */
export function scalePixels(src: Pixels, dstW: number, dstH: number): Pixels {
  if (dstW === src.w && dstH === src.h) {
    return { data: new Uint8ClampedArray(src.data), w: src.w, h: src.h };
  }
  let buf = toPremulLinear(src);
  let curW = src.w;
  if (dstW !== src.w) {
    buf = resampleAxis(buf, src.w, src.h, dstW, 4, src.w * 4, 4, dstW * 4);
    curW = dstW;
  }
  if (dstH !== src.h) {
    buf = resampleAxis(buf, src.h, curW, dstH, curW * 4, 4, curW * 4, 4);
  }
  return fromPremulLinear(buf, dstW, dstH);
}

/**
 * Rotate around the center by deg (positive = clockwise in screen coords).
 * Output is sized to the rotated bounding box per outputSize. Multiples of
 * 90° are exact pixel shuffles; anything else inverse-maps each destination
 * pixel and bilinearly samples the source in premultiplied linear light,
 * with out-of-source neighbors contributing full transparency.
 */
export function rotatePixels(src: Pixels, deg: number): Pixels {
  const d = ((deg % 360) + 360) % 360;
  const { w, h } = src;

  if (d === 0) return { data: new Uint8ClampedArray(src.data), w, h };

  if (d === 90 || d === 180 || d === 270) {
    const W = d === 180 ? w : h;
    const H = d === 180 ? h : w;
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let dx: number, dy: number;
        if (d === 90) { dx = h - 1 - y; dy = x; }
        else if (d === 180) { dx = w - 1 - x; dy = h - 1 - y; }
        else { dx = y; dy = w - 1 - x; }
        const s = (y * w + x) * 4;
        const t = (dy * W + dx) * 4;
        out[t] = src.data[s] as number;
        out[t + 1] = src.data[s + 1] as number;
        out[t + 2] = src.data[s + 2] as number;
        out[t + 3] = src.data[s + 3] as number;
      }
    }
    return { data: out, w: W, h: H };
  }

  const { w: W, h: H } = outputSize(w, h, { scale: 1, rotateDeg: d });
  const rad = (d * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lin = toPremulLinear(src);
  const buf = new Float64Array(W * H * 4);
  const cxD = W / 2, cyD = H / 2;
  const cxS = w / 2, cyS = h / 2;

  for (let dy = 0; dy < H; dy++) {
    const dv = dy + 0.5 - cyD;
    for (let dx = 0; dx < W; dx++) {
      const du = dx + 0.5 - cxD;
      // Inverse of the clockwise rotation [u·cos − v·sin, u·sin + v·cos].
      const sx = du * cos + dv * sin + cxS - 0.5;
      const sy = -du * sin + dv * cos + cyS - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      let r = 0, g = 0, b = 0, a = 0;
      for (let n = 0; n < 4; n++) {
        const xi = x0 + (n & 1);
        const yi = y0 + (n >> 1);
        if (xi < 0 || xi >= w || yi < 0 || yi >= h) continue; // transparent outside
        const wt = (n & 1 ? fx : 1 - fx) * (n >> 1 ? fy : 1 - fy);
        if (wt === 0) continue;
        const o = (yi * w + xi) * 4;
        r += (lin[o] as number) * wt;
        g += (lin[o + 1] as number) * wt;
        b += (lin[o + 2] as number) * wt;
        a += (lin[o + 3] as number) * wt;
      }
      const t = (dy * W + dx) * 4;
      buf[t] = r;
      buf[t + 1] = g;
      buf[t + 2] = b;
      buf[t + 3] = a;
    }
  }
  return fromPremulLinear(buf, W, H);
}

/**
 * Final output size: rotated bounding box, then uniform scale, floored at 1.
 * W = round(|w·cosθ| + |h·sinθ|), H = round(|w·sinθ| + |h·cosθ|),
 * result = max(1, round(W·scale)) × max(1, round(H·scale)).
 */
export function outputSize(
  w: number,
  h: number,
  opts: { scale: number; rotateDeg: number },
): { w: number; h: number } {
  const rad = (opts.rotateDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const W = Math.round(w * c + h * s);
  const H = Math.round(w * s + h * c);
  return {
    w: Math.max(1, Math.round(W * opts.scale)),
    h: Math.max(1, Math.round(H * opts.scale)),
  };
}
