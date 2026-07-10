/**
 * sRGB transfer functions (IEC 61966-2-1).
 *
 * Images store gamma-encoded values (≈ sqrt of linear light); all pixel math
 * must decode to linear (≈ squaring), operate, then re-encode (≈ sqrt).
 * LUT-backed for per-pixel speed. The encode LUT is indexed in the sqrt
 * domain so dark tones get the resolution they need for exact round-trips.
 */

const DECODE_LUT = new Float64Array(256);
for (let v = 0; v < 256; v++) {
  const c = v / 255;
  DECODE_LUT[v] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const ENCODE_BITS = 12;
const ENCODE_SIZE = 1 << ENCODE_BITS; // 4096
const ENCODE_LUT = new Uint8Array(ENCODE_SIZE);
for (let i = 0; i < ENCODE_SIZE; i++) {
  const s = i / (ENCODE_SIZE - 1); // sqrt-domain sample
  const x = s * s; // linear value
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  ENCODE_LUT[i] = Math.round(c * 255);
}

/** Decode an 8-bit sRGB channel to linear light in [0, 1]. */
export function srgbToLinear(v: number): number {
  return DECODE_LUT[v & 0xff] as number;
}

/** Encode linear light in [0, 1] back to an 8-bit sRGB channel. */
export function linearToSrgb(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 255;
  return ENCODE_LUT[Math.round(Math.sqrt(x) * (ENCODE_SIZE - 1))] as number;
}
