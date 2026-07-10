import { describe, expect, it } from "vitest";
import { srgbToLinear, linearToSrgb } from "../src/engine/gamma";

describe("srgbToLinear", () => {
  it("maps 0 to 0 and 255 to 1", () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(255)).toBe(1);
  });

  it("maps mid-gray 128 to ~0.2159 linear (gamma, not linear ramp)", () => {
    expect(srgbToLinear(128)).toBeCloseTo(0.21586, 4);
  });

  it("is strictly monotonic", () => {
    for (let v = 1; v < 256; v++) {
      expect(srgbToLinear(v)).toBeGreaterThan(srgbToLinear(v - 1));
    }
  });

  it("uses the linear segment near black (sRGB piecewise)", () => {
    // v=8 → c=0.03137 ≤ 0.04045 → c/12.92
    expect(srgbToLinear(8)).toBeCloseTo(8 / 255 / 12.92, 6);
  });
});

describe("linearToSrgb", () => {
  it("maps 0 to 0 and 1 to 255", () => {
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBe(255);
  });

  it("clamps out-of-range input", () => {
    expect(linearToSrgb(-0.5)).toBe(0);
    expect(linearToSrgb(1.5)).toBe(255);
  });

  it("round-trips every 8-bit value exactly", () => {
    for (let v = 0; v < 256; v++) {
      expect(linearToSrgb(srgbToLinear(v))).toBe(v);
    }
  });

  it("encodes linear mid-light 0.5 to sRGB ~188 (sqrt-like curve)", () => {
    expect(linearToSrgb(0.5)).toBe(188);
  });
});
