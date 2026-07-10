/**
 * Brightness/contrast adjustment in linear light.
 *
 * Both controls operate on decoded (linear) values so they behave like
 * physical light: brightness is an exposure gain (2^(2b) stops) and contrast
 * is a slope change around mid-gray. Contrast pivots on the linear value of
 * sRGB 128 so mid-gray stays put; slope = tan((c+1)·π/4) maps c ∈ [-1, 1]
 * onto [0, ∞) with c = 0 giving slope 1 (identity).
 */

import { linearToSrgb, srgbToLinear } from './gamma';

/** Linear-light value of sRGB mid-gray (128), the contrast pivot. */
export const CONTRAST_PIVOT = 0.21586;

/**
 * Apply contrast then brightness to an RGBA buffer, in place.
 * Alpha bytes are never touched.
 *
 * @param brightness -1..1; 0 = identity. Exposure-style: linear ×= 2^(2b).
 * @param contrast   -1..1; 0 = identity. Slope tan((c+1)·π/4) about the pivot.
 */
export function applyBrightnessContrast(
  data: Uint8ClampedArray,
  brightness: number,
  contrast: number
): void {
  const slope = Math.tan(((contrast + 1) * Math.PI) / 4);
  const gain = Math.pow(2, 2 * brightness);

  // Every pixel shares the same 8-bit → 8-bit mapping: bake it into a LUT.
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const x = (srgbToLinear(v) - CONTRAST_PIVOT) * slope + CONTRAST_PIVOT;
    lut[v] = linearToSrgb(x * gain);
  }

  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i] as number] as number;
    data[i + 1] = lut[data[i + 1] as number] as number;
    data[i + 2] = lut[data[i + 2] as number] as number;
    // data[i + 3] (alpha) intentionally untouched
  }
}
