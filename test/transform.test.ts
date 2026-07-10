import { describe, it, expect } from 'vitest';
import { linearToSrgb } from '../src/engine/gamma';
import {
  clampRect,
  cropPixels,
  scalePixels,
  rotatePixels,
  outputSize,
  type Pixels,
} from '../src/engine/transform';

function px(w: number, h: number, bytes: number[]): Pixels {
  if (bytes.length !== w * h * 4) throw new Error('bad fixture');
  return { data: new Uint8ClampedArray(bytes), w, h };
}

function solid(w: number, h: number, rgba: [number, number, number, number]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { data, w, h };
}

function at(p: Pixels, x: number, y: number): number[] {
  const i = (y * p.w + x) * 4;
  return [p.data[i] as number, p.data[i + 1] as number, p.data[i + 2] as number, p.data[i + 3] as number];
}

describe('clampRect', () => {
  it('clamps negative origin to 0 and preserves the right/bottom edge', () => {
    expect(clampRect({ x: -5, y: -3, w: 10, h: 10 }, 8, 8)).toEqual({ x: 0, y: 0, w: 5, h: 7 });
  });

  it('clamps overflow to the bounds', () => {
    expect(clampRect({ x: 5, y: 6, w: 10, h: 10 }, 8, 8)).toEqual({ x: 5, y: 6, w: 3, h: 2 });
  });

  it('turns zero/negative size into 1x1', () => {
    expect(clampRect({ x: 2, y: 2, w: 0, h: -3 }, 8, 8)).toEqual({ x: 2, y: 2, w: 1, h: 1 });
  });

  it('snaps fractional inputs to integers', () => {
    const r = clampRect({ x: 1.4, y: 1.6, w: 2.5, h: 2.5 }, 8, 8);
    expect(r).toEqual({ x: 1, y: 2, w: 3, h: 2 }); // edges: round(1.4)=1, round(3.9)=4; round(1.6)=2, round(4.1)=4
    expect(Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h)).toBe(true);
  });

  it('keeps a fully out-of-bounds rect inside as 1x1', () => {
    expect(clampRect({ x: 100, y: 100, w: 5, h: 5 }, 8, 8)).toEqual({ x: 7, y: 7, w: 1, h: 1 });
  });
});

describe('cropPixels', () => {
  it('extracts exact bytes from a known 4x4 pattern', () => {
    const src = px(4, 4, Array.from({ length: 64 }, (_, i) => i));
    const out = cropPixels(src, { x: 1, y: 1, w: 2, h: 2 });
    expect(out.w).toBe(2);
    expect(out.h).toBe(2);
    expect(Array.from(out.data)).toEqual([
      20, 21, 22, 23, 24, 25, 26, 27, // src pixels (1,1) (2,1)
      36, 37, 38, 39, 40, 41, 42, 43, // src pixels (1,2) (2,2)
    ]);
  });
});

describe('scalePixels', () => {
  it('identity size returns identical bytes', () => {
    const src = px(2, 2, [
      255, 0, 0, 255, 0, 255, 0, 128,
      13, 77, 200, 3, 0, 0, 0, 0,
    ]);
    const out = scalePixels(src, 2, 2);
    expect(out.w).toBe(2);
    expect(out.h).toBe(2);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('downscales in linear light: 2x2 black/white checker -> sRGB 188, not 128', () => {
    const src = px(2, 2, [
      255, 255, 255, 255, 0, 0, 0, 255,
      0, 0, 0, 255, 255, 255, 255, 255,
    ]);
    const out = scalePixels(src, 1, 1);
    expect(Array.from(out.data)).toEqual([188, 188, 188, 255]);
  });

  it('alpha-weights colors so transparent pixels do not bleed', () => {
    const src = px(2, 1, [
      255, 0, 0, 255, // opaque red
      0, 255, 0, 0, //   fully transparent green
    ]);
    const out = scalePixels(src, 1, 1);
    const [r, g, , a] = at(out, 0, 0) as [number, number, number, number];
    expect(Math.abs(a - 128)).toBeLessThanOrEqual(1);
    expect(r).toBeGreaterThan(200); // hue stays red after unpremultiply
    expect(g).toBeLessThan(50);
  });

  it('produces the requested dimensions', () => {
    const out = scalePixels(solid(4, 4, [10, 20, 30, 255]), 3, 5);
    expect(out.w).toBe(3);
    expect(out.h).toBe(5);
    expect(out.data.length).toBe(3 * 5 * 4);
  });

  it('upscales with bilinear interpolation in linear light', () => {
    const src = px(1, 2, [
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]);
    const out = scalePixels(src, 1, 4);
    expect(at(out, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(at(out, 0, 3)).toEqual([255, 255, 255, 255]);
    const q1 = (at(out, 0, 1) as number[])[0] as number;
    const q3 = (at(out, 0, 2) as number[])[0] as number;
    expect(Math.abs(q1 - linearToSrgb(0.25))).toBeLessThanOrEqual(1);
    expect(Math.abs(q3 - linearToSrgb(0.75))).toBeLessThanOrEqual(1);
  });
});

describe('rotatePixels', () => {
  const A = [255, 0, 0, 255];
  const B = [0, 255, 0, 200];
  const C = [0, 0, 255, 255];
  const D = [255, 255, 0, 100];
  const E = [255, 0, 255, 255];
  const F = [0, 255, 255, 50];

  it('rotates 90 degrees (clockwise) as an exact pixel shuffle', () => {
    const src = px(2, 3, [...A, ...B, ...C, ...D, ...E, ...F]);
    const out = rotatePixels(src, 90);
    expect(out.w).toBe(3);
    expect(out.h).toBe(2);
    expect(Array.from(out.data)).toEqual([...E, ...C, ...A, ...F, ...D, ...B]);
  });

  it('rotating 180 twice is the identity', () => {
    const src = px(2, 3, [...A, ...B, ...C, ...D, ...E, ...F]);
    const once = rotatePixels(src, 180);
    expect(Array.from(once.data)).toEqual([...F, ...E, ...D, ...C, ...B, ...A]);
    const twice = rotatePixels(once, 180);
    expect(twice.w).toBe(2);
    expect(twice.h).toBe(3);
    expect(Array.from(twice.data)).toEqual(Array.from(src.data));
  });

  it('rotate 0 is the identity', () => {
    const src = px(2, 3, [...A, ...B, ...C, ...D, ...E, ...F]);
    const out = rotatePixels(src, 0);
    expect(out.w).toBe(2);
    expect(out.h).toBe(3);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('rotate 360 keeps the source dimensions (and bytes)', () => {
    const src = px(2, 3, [...A, ...B, ...C, ...D, ...E, ...F]);
    const out = rotatePixels(src, 360);
    expect(out.w).toBe(2);
    expect(out.h).toBe(3);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('rotate 45 on 10x10: bbox size, transparent corners, opaque center', () => {
    const src = solid(10, 10, [255, 0, 0, 255]);
    const out = rotatePixels(src, 45);
    expect(out.w).toBe(14); // round(10*cos45 + 10*sin45) = round(14.142)
    expect(out.h).toBe(14);
    for (const [x, y] of [[0, 0], [13, 0], [0, 13], [13, 13]] as const) {
      expect((at(out, x, y) as number[])[3]).toBe(0);
    }
    const center = at(out, 7, 7) as number[];
    expect(center[3]).toBe(255);
    expect(center[0]).toBe(255); // still pure red
  });
});

describe('outputSize', () => {
  it('applies scale after the (trivial) rotation bbox', () => {
    expect(outputSize(100, 50, { scale: 0.5, rotateDeg: 0 })).toEqual({ w: 50, h: 25 });
  });

  it('floors tiny scales at 1x1', () => {
    expect(outputSize(100, 50, { scale: 0.0001, rotateDeg: 0 })).toEqual({ w: 1, h: 1 });
  });

  it('swaps dimensions at 90 degrees', () => {
    expect(outputSize(100, 50, { scale: 1, rotateDeg: 90 })).toEqual({ w: 50, h: 100 });
  });

  it('matches the bbox formula at 45 degrees', () => {
    const s = Math.SQRT1_2;
    expect(outputSize(100, 50, { scale: 1, rotateDeg: 45 })).toEqual({
      w: Math.round(100 * s + 50 * s), // 106
      h: Math.round(100 * s + 50 * s), // 106
    });
    expect(outputSize(10, 10, { scale: 1, rotateDeg: 45 })).toEqual({ w: 14, h: 14 });
  });
});
