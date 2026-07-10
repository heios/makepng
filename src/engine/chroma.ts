import { srgbToLinear } from "./gamma";

const INV_SQRT3 = 1 / Math.sqrt(3);

/**
 * Chroma-key an RGBA buffer in place by attenuating alpha near a key color.
 *
 * Distance to the key is Euclidean in LINEAR light (sRGB-decoded channels),
 * normalized to [0, 1] by 1/sqrt(3). Colors within the tolerance are fully
 * removed; colors NEARBY in color space (within `spread` beyond the
 * tolerance) are partially removed, fading linearly with distance:
 *   d <= tolerance            → 0
 *   d >= tolerance + spread   → 1
 *   otherwise                 → (d - tolerance) / spread
 * (spread === 0 is a hard cutoff at the tolerance.)
 *
 * New alpha = round(existingAlpha * f): multiplies into existing alpha and
 * never increases it. RGB channels are left untouched.
 */
export function applyChromaKey(
  data: Uint8ClampedArray,
  key: readonly [number, number, number],
  tolerance: number,
  spread: number
): void {
  // Decode the key once outside the loop.
  const kr = srgbToLinear(key[0]);
  const kg = srgbToLinear(key[1]);
  const kb = srgbToLinear(key[2]);
  const hi = tolerance + spread;
  const len = data.length;

  for (let i = 0; i < len; i += 4) {
    const a = data[i + 3] as number;
    if (a === 0) continue; // already transparent; nothing can decrease

    const dr = srgbToLinear(data[i] as number) - kr;
    const dg = srgbToLinear(data[i + 1] as number) - kg;
    const db = srgbToLinear(data[i + 2] as number) - kb;
    const d = Math.sqrt(dr * dr + dg * dg + db * db) * INV_SQRT3;

    if (d <= tolerance) {
      data[i + 3] = 0; // f = 0
      continue;
    }
    if (spread === 0 || d >= hi) continue; // f = 1: alpha unchanged
    const f = (d - tolerance) / spread;
    data[i + 3] = Math.round(a * f);
  }
}
