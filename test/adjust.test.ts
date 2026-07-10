import { describe, expect, it } from 'vitest';
import {
  CONTRAST_PIVOT,
  applyBrightnessContrast,
} from '../src/engine/adjust';
import { linearToSrgb, srgbToLinear } from '../src/engine/gamma';

/** Build an RGBA buffer from a list of channel values (alpha = given or 255). */
function rgba(values: number[], alpha = 255): Uint8ClampedArray {
  const data = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = alpha;
  }
  return data;
}

/** Extract only the RGB bytes of an RGBA buffer. */
function rgbOf(data: Uint8ClampedArray): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    out.push(data[i] as number, data[i + 1] as number, data[i + 2] as number);
  }
  return out;
}

const VARIED = [0, 1, 7, 32, 64, 100, 128, 130, 180, 200, 254, 255];

describe('CONTRAST_PIVOT', () => {
  it('is the linear value of sRGB mid-gray 128', () => {
    expect(CONTRAST_PIVOT).toBeCloseTo(srgbToLinear(128), 4);
    expect(CONTRAST_PIVOT).toBeCloseTo(0.21586, 5);
  });
});

describe('applyBrightnessContrast', () => {
  it('(0, 0) is the identity for varied values', () => {
    const data = rgba(VARIED, 200);
    const before = Array.from(data);
    applyBrightnessContrast(data, 0, 0);
    expect(Array.from(data)).toEqual(before);
  });

  it('brightness +0.5 strictly increases every non-black, non-saturated channel; black stays 0', () => {
    const values = [1, 7, 32, 64, 100, 128, 180, 200];
    const data = rgba([0, ...values]);
    applyBrightnessContrast(data, 0.5, 0);
    // black stays black
    expect(data[0]).toBe(0);
    for (let i = 0; i < values.length; i++) {
      const original = values[i] as number;
      const after = data[(i + 1) * 4] as number;
      expect(after, `value ${original}`).toBeGreaterThan(original);
    }
  });

  it('brightness -0.5 strictly decreases mid-tones', () => {
    const values = [32, 64, 100, 128, 180, 220];
    const data = rgba(values);
    applyBrightnessContrast(data, -0.5, 0);
    for (let i = 0; i < values.length; i++) {
      const original = values[i] as number;
      const after = data[i * 4] as number;
      expect(after, `value ${original}`).toBeLessThan(original);
    }
  });

  it('contrast +0.5 pushes values above 128 up, below 128 down, and keeps 128 fixed (±1)', () => {
    const below = [16, 48, 80, 112];
    const above = [144, 176, 208, 240];
    const data = rgba([...below, 128, ...above]);
    applyBrightnessContrast(data, 0, 0.5);
    for (let i = 0; i < below.length; i++) {
      const original = below[i] as number;
      const after = data[i * 4] as number;
      expect(after, `value ${original}`).toBeLessThan(original);
    }
    const mid = data[below.length * 4] as number;
    expect(Math.abs(mid - 128)).toBeLessThanOrEqual(1);
    for (let i = 0; i < above.length; i++) {
      const original = above[i] as number;
      const after = data[(below.length + 1 + i) * 4] as number;
      expect(after, `value ${original}`).toBeGreaterThan(original);
    }
  });

  it('contrast -1 collapses everything to sRGB 128 (±1)', () => {
    const data = rgba(VARIED);
    applyBrightnessContrast(data, 0, -1);
    for (const v of rgbOf(data)) {
      expect(Math.abs(v - 128)).toBeLessThanOrEqual(1);
    }
  });

  it('never modifies the alpha channel', () => {
    // varied alphas across pixels
    const data = new Uint8ClampedArray(VARIED.length * 4);
    const alphas: number[] = [];
    for (let i = 0; i < VARIED.length; i++) {
      const v = VARIED[i] as number;
      const a = (i * 37 + 3) % 256;
      alphas.push(a);
      data[i * 4] = v;
      data[i * 4 + 1] = 255 - v;
      data[i * 4 + 2] = (v * 3) % 256;
      data[i * 4 + 3] = a;
    }
    applyBrightnessContrast(data, 0.7, -0.3);
    applyBrightnessContrast(data, -1, 1);
    for (let i = 0; i < alphas.length; i++) {
      expect(data[i * 4 + 3]).toBe(alphas[i] as number);
    }
  });

  it('operates in linear light: brightness +1 maps sRGB 128 to ~240, not 255', () => {
    const data = rgba([128]);
    applyBrightnessContrast(data, 1, 0);
    const after = data[0] as number;
    // linear 0.21586 * 4 = 0.86345 -> encode ≈ 0.9414 * 255 ≈ 240
    expect(Math.abs(after - 240)).toBeLessThanOrEqual(1);
    // definitely NOT a gamma-space multiply clamped to 255
    expect(after).toBeLessThan(250);
  });

  it('applies contrast before brightness', () => {
    // For v=200: contrast +0.5 then brightness -0.5 differs from the reverse
    // order when computed in linear light. Verify against a direct reference.
    const v = 200;
    const slope = Math.tan(((0.5 + 1) * Math.PI) / 4);
    const gain = Math.pow(2, 2 * -0.5);
    const x = (srgbToLinear(v) - CONTRAST_PIVOT) * slope + CONTRAST_PIVOT;
    const expected = linearToSrgb(x * gain);
    const data = rgba([v]);
    applyBrightnessContrast(data, -0.5, 0.5);
    expect(data[0]).toBe(expected);
  });

  it('matches per-channel reference math on a varied buffer', () => {
    const brightness = 0.25;
    const contrast = -0.4;
    const slope = Math.tan(((contrast + 1) * Math.PI) / 4);
    const gain = Math.pow(2, 2 * brightness);
    const data = new Uint8ClampedArray(256 * 4);
    for (let v = 0; v < 256; v++) {
      data[v * 4] = v;
      data[v * 4 + 1] = v;
      data[v * 4 + 2] = v;
      data[v * 4 + 3] = v;
    }
    applyBrightnessContrast(data, brightness, contrast);
    for (let v = 0; v < 256; v++) {
      const x = (srgbToLinear(v) - CONTRAST_PIVOT) * slope + CONTRAST_PIVOT;
      const expected = linearToSrgb(x * gain);
      expect(data[v * 4], `value ${v}`).toBe(expected);
      expect(data[v * 4 + 3], `alpha ${v}`).toBe(v);
    }
  });
});
