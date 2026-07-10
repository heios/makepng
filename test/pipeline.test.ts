import { describe, expect, it } from "vitest";
import { applyBrightnessContrast } from "../src/engine/adjust";
import { applyChromaKey } from "../src/engine/chroma";
import { outputSize, rotatePixels, scalePixels, type Pixels } from "../src/engine/transform";

function solid(w: number, h: number, rgba: [number, number, number, number]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { data, w, h };
}

/** The exact download pipeline from main.ts (geometry part). */
function downloadGeometry(src: Pixels, scale: number, rotateDeg: number): Pixels {
  const target = outputSize(src.w, src.h, { scale, rotateDeg });
  let buf = src;
  if (scale < 1) {
    buf = scalePixels(src, Math.max(1, Math.round(src.w * scale)), Math.max(1, Math.round(src.h * scale)));
  }
  buf = rotatePixels(buf, rotateDeg);
  if (buf.w !== target.w || buf.h !== target.h) buf = scalePixels(buf, target.w, target.h);
  return buf;
}

describe("pipeline integration", () => {
  it("download geometry always matches the outputSize contract (the size readout)", () => {
    const cases: Array<[number, number, number, number]> = [
      [100, 50, 1, 0],
      [100, 50, 0.5, 0],
      [100, 50, 2, 0],
      [100, 50, 1, 90],
      [101, 47, 0.33, 45],
      [64, 64, 0.1, 137],
      [3, 3, 4, -30],
    ];
    for (const [w, h, scale, rot] of cases) {
      const src = solid(w, h, [200, 100, 50, 255]);
      const out = downloadGeometry(src, scale, rot);
      const expected = outputSize(w, h, { scale, rotateDeg: rot });
      expect({ w: out.w, h: out.h }).toEqual(expected);
    }
  });

  it("keys a color picked from the ADJUSTED image (pick-after-adjust flow)", () => {
    // Mid-gray image, strong brightness: the user sees (and picks) the brightened color.
    const img = solid(4, 4, [128, 128, 128, 255]);
    applyBrightnessContrast(img.data, 0.5, 0.2);
    const picked: [number, number, number] = [img.data[0] as number, img.data[1] as number, img.data[2] as number];
    applyChromaKey(img.data, picked, 0.01, 0);
    for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(0);
  });

  it("keying with the PRE-adjust color after adjusting does NOT key (regression: order matters)", () => {
    const img = solid(4, 4, [128, 128, 128, 255]);
    applyBrightnessContrast(img.data, 0.5, 0.2);
    applyChromaKey(img.data, [128, 128, 128], 0.01, 0);
    for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(255);
  });

  it("full pipeline on a bordered image: rotate+scale+adjust+key leaves border transparent, center opaque", () => {
    // 20×20 white image with a 6px-wide centered red square; key white.
    const p = solid(20, 20, [255, 255, 255, 255]);
    for (let y = 7; y < 13; y++) {
      for (let x = 7; x < 13; x++) {
        const i = (y * 20 + x) * 4;
        p.data[i] = 220;
        p.data[i + 1] = 30;
        p.data[i + 2] = 40;
      }
    }
    const out = downloadGeometry(p, 0.8, 30);
    applyBrightnessContrast(out.data, 0.1, 0);
    const keyWhite = outputSize(20, 20, { scale: 0.8, rotateDeg: 30 });
    expect({ w: out.w, h: out.h }).toEqual(keyWhite);
    // Key the brightened white: sample a corner-adjacent white area? Use the
    // brightened value of pure white = still 255 (clamped).
    applyChromaKey(out.data, [255, 255, 255], 0.08, 0.05);
    const alphaAt = (x: number, y: number) => out.data[(y * out.w + x) * 4 + 3] as number;
    const cx = Math.floor(out.w / 2);
    const cy = Math.floor(out.h / 2);
    expect(alphaAt(cx, cy)).toBe(255); // red center survives
    expect(alphaAt(0, 0)).toBe(0); // rotation corner (already transparent) stays transparent
    expect(alphaAt(cx, 1)).toBe(0); // white area keyed out
  });
});
