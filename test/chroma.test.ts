import { describe, it, expect } from "vitest";
import { applyChromaKey } from "../src/engine/chroma";
import { srgbToLinear } from "../src/engine/gamma";

/** Build an RGBA buffer from a list of [r, g, b, a] pixels. */
function pixels(...px: ReadonlyArray<readonly [number, number, number, number]>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(px.length * 4);
  for (let i = 0; i < px.length; i++) {
    const p = px[i] as readonly [number, number, number, number];
    data[i * 4] = p[0];
    data[i * 4 + 1] = p[1];
    data[i * 4 + 2] = p[2];
    data[i * 4 + 3] = p[3];
  }
  return data;
}

/** Normalized linear-light distance between two sRGB colors, mirroring the spec. */
function linearDistance(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): number {
  const dr = srgbToLinear(a[0]) - srgbToLinear(b[0]);
  const dg = srgbToLinear(a[1]) - srgbToLinear(b[1]);
  const db = srgbToLinear(a[2]) - srgbToLinear(b[2]);
  return Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3);
}

describe("applyChromaKey", () => {
  it("keys the exact key color to alpha 0 and leaves a different pixel opaque (tolerance 0, feather 0)", () => {
    const data = pixels([0, 255, 0, 255], [255, 0, 0, 255]);
    applyChromaKey(data, [0, 255, 0], 0, 0);
    expect(data[3]).toBe(0); // exact key match
    expect(data[7]).toBe(255); // clearly different pixel untouched
  });

  it("never modifies RGB channels", () => {
    const data = pixels(
      [0, 255, 0, 255],
      [10, 250, 5, 255],
      [255, 0, 0, 128],
      [0, 0, 0, 0]
    );
    const before = Array.from(data);
    applyChromaKey(data, [0, 255, 0], 0.3, 0.2);
    for (let i = 0; i < data.length; i += 4) {
      expect(data[i]).toBe(before[i]);
      expect(data[i + 1]).toBe(before[i + 1]);
      expect(data[i + 2]).toBe(before[i + 2]);
    }
  });

  it("with tolerance 0 and feather 0, keys ONLY the exact key color", () => {
    const data = pixels(
      [0, 255, 0, 255], // exact key
      [0, 254, 0, 255], // one 8-bit step away
      [1, 255, 0, 255], // one 8-bit step away on another channel
      [0, 255, 1, 255]
    );
    applyChromaKey(data, [0, 255, 0], 0, 0);
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(255);
    expect(data[11]).toBe(255);
    expect(data[15]).toBe(255);
  });

  it("feather = 0 is a hard cutoff at the tolerance", () => {
    // Keyed on black: sRGB 40 has linear ~0.021 (inside tol 0.05),
    // sRGB 128 has linear ~0.216 (outside).
    const data = pixels([40, 40, 40, 255], [128, 128, 128, 255]);
    applyChromaKey(data, [0, 0, 0], 0.05, 0);
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(255);
  });

  it("with feather > 0, alpha is monotonically non-decreasing with distance from key", () => {
    const n = 256;
    const data = new Uint8ClampedArray(n * 4);
    for (let v = 0; v < n; v++) {
      data[v * 4] = v;
      data[v * 4 + 1] = v;
      data[v * 4 + 2] = v;
      data[v * 4 + 3] = 255;
    }
    applyChromaKey(data, [0, 0, 0], 0.1, 0.4);
    for (let v = 1; v < n; v++) {
      const prev = data[(v - 1) * 4 + 3] as number;
      const cur = data[v * 4 + 3] as number;
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
    // and the ramp actually spans the range: black keyed out, white opaque
    expect(data[3]).toBe(0);
    expect(data[255 * 4 + 3]).toBe(255);
  });

  it("smoothstep feather band produces intermediate alpha", () => {
    const key: readonly [number, number, number] = [0, 0, 0];
    const tolerance = 0.05;
    const feather = 0.3;
    // sRGB 128 → d ≈ 0.216, inside (0.05, 0.35): expect smoothstep value
    const data = pixels([128, 128, 128, 255]);
    applyChromaKey(data, key, tolerance, feather);
    const d = linearDistance([128, 128, 128], key);
    const t = (d - tolerance) / feather;
    const f = t * t * (3 - 2 * t);
    expect(data[3]).toBe(Math.round(255 * f));
    expect(data[3] as number).toBeGreaterThan(0);
    expect(data[3] as number).toBeLessThan(255);
  });

  it("multiplies into existing alpha and never increases it", () => {
    const key: readonly [number, number, number] = [0, 0, 0];
    const tolerance = 0.05;
    const feather = 0.3;
    const data = pixels(
      [0, 0, 0, 0], // already transparent, inside key → stays 0
      [255, 255, 255, 0], // already transparent, far from key → stays 0
      [255, 255, 255, 128], // semi-transparent, outside keyed range → stays 128
      [128, 128, 128, 128] // semi-transparent, in the feather band → scales DOWN
    );
    applyChromaKey(data, key, tolerance, feather);
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(0);
    expect(data[11]).toBe(128);

    const d = linearDistance([128, 128, 128], key);
    const t = (d - tolerance) / feather;
    const f = t * t * (3 - 2 * t);
    expect(data[15]).toBe(Math.round(128 * f));
    expect(data[15] as number).toBeLessThan(128);
    expect(data[15] as number).toBeGreaterThan(0);
  });

  it("computes distance in linear light, not gamma space", () => {
    // Keying black with tolerance 0.05, feather 0:
    // - sRGB 128: linear ≈ 0.2159 → d ≈ 0.2159 > 0.05 → stays opaque.
    // - sRGB 40: linear ≈ 0.0212 → d ≈ 0.0212 < 0.05 → keyed out,
    //   even though 40/255 ≈ 0.157 > 0.05 would keep it opaque in gamma space.
    expect(linearDistance([128, 128, 128], [0, 0, 0])).toBeGreaterThan(0.2);
    expect(linearDistance([40, 40, 40], [0, 0, 0])).toBeLessThan(0.05);
    expect(40 / 255).toBeGreaterThan(0.05); // the gamma-space trap

    const data = pixels([128, 128, 128, 255], [40, 40, 40, 255]);
    applyChromaKey(data, [0, 0, 0], 0.05, 0);
    expect(data[3]).toBe(255); // gray 128 remains opaque
    expect(data[7]).toBe(0); // gray 40 becomes transparent
  });

  it("boundary behavior with feather: f = 0 at d <= tolerance, f = 1 at d >= tolerance + feather", () => {
    const key: readonly [number, number, number] = [0, 0, 0];
    // gray 128 → d ≈ 0.2159
    const d = linearDistance([128, 128, 128], key);
    const dataLow = pixels([128, 128, 128, 255]);
    applyChromaKey(dataLow, key, d + 0.001, 0.2); // d <= tolerance → 0
    expect(dataLow[3]).toBe(0);

    const dataHigh = pixels([128, 128, 128, 255]);
    applyChromaKey(dataHigh, key, 0.01, d - 0.02); // d >= tol + feather → 1
    expect(dataHigh[3]).toBe(255);
  });
});
