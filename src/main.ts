import "./style.css";
import { applyBrightnessContrast } from "./engine/adjust";
import { applyChromaKey } from "./engine/chroma";
import {
  clampRect,
  cropPixels,
  outputSize,
  rotatePixels,
  scalePixels,
  type Pixels,
  type Rect,
} from "./engine/transform";

const PREVIEW_MAX = 1000;
const TOL_MAX = 0.5; // sensitivity slider 0..100 → tolerance 0..0.5
const FEATHER_MAX = 0.25; // feather slider 0..100 → 0..0.25

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const dropzone = $<HTMLDivElement>("dropzone");
const fileInput = $<HTMLInputElement>("file-input");
const workspace = $<HTMLDivElement>("workspace");
const checker = $<HTMLDivElement>("checker");
const view = $<HTMLCanvasElement>("view");
const overlay = $<HTMLCanvasElement>("overlay");
const cropToggle = $<HTMLButtonElement>("crop-toggle");
const cropApply = $<HTMLButtonElement>("crop-apply");
const resetImage = $<HTMLButtonElement>("reset-image");
const pickToggle = $<HTMLButtonElement>("pick-toggle");
const keySwatch = $<HTMLSpanElement>("key-swatch");
const keyClear = $<HTMLButtonElement>("key-clear");
const sizeReadout = $<HTMLParagraphElement>("size-readout");
const downloadBtn = $<HTMLButtonElement>("download");

const sliders = {
  tol: $<HTMLInputElement>("tol"),
  feather: $<HTMLInputElement>("feather"),
  brightness: $<HTMLInputElement>("brightness"),
  contrast: $<HTMLInputElement>("contrast"),
  rotate: $<HTMLInputElement>("rotate"),
  scale: $<HTMLInputElement>("scale"),
};

interface Params {
  tol: number;
  feather: number;
  brightness: number;
  contrast: number;
  rotate: number;
  scale: number;
  key: readonly [number, number, number] | null;
}

let original: Pixels | null = null;
let working: Pixels | null = null;
let previewBase: Pixels | null = null;
let pickBuffer: Pixels | null = null; // preview after rotate+adjust, before chroma
let params: Params = defaultParams();

let cropping = false;
let picking = false;
let selection: Rect | null = null;
let dragStart: { x: number; y: number } | null = null;

function defaultParams(): Params {
  return { tol: 0.15 * TOL_MAX, feather: 0.1 * FEATHER_MAX, brightness: 0, contrast: 0, rotate: 0, scale: 1, key: null };
}

function clone(p: Pixels): Pixels {
  return { data: new Uint8ClampedArray(p.data), w: p.w, h: p.h };
}

// ---------- loading ----------

async function loadImage(source: Blob): Promise<void> {
  const bitmap = await createImageBitmap(source);
  const c = document.createElement("canvas");
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = ctx.getImageData(0, 0, c.width, c.height);
  original = { data: img.data, w: img.width, h: img.height };
  working = clone(original);
  params = defaultParams();
  syncSlidersFromParams();
  setCropping(false);
  setPicking(false);
  setKey(null);
  rebuildPreviewBase();
  dropzone.hidden = true;
  workspace.hidden = false;
  scheduleRender();
}

function rebuildPreviewBase(): void {
  if (!working) return;
  const s = Math.min(1, PREVIEW_MAX / Math.max(working.w, working.h));
  const w = Math.max(1, Math.round(working.w * s));
  const h = Math.max(1, Math.round(working.h * s));
  previewBase = s === 1 ? clone(working) : scalePixels(working, w, h);
}

// ---------- rendering ----------

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render(): void {
  if (!previewBase || !working) return;
  const rotated = rotatePixels(previewBase, params.rotate);
  applyBrightnessContrast(rotated.data, params.brightness, params.contrast);
  pickBuffer = rotated;
  let result = rotated;
  if (params.key) {
    result = clone(rotated);
    applyChromaKey(result.data, params.key, params.tol, params.feather);
  }
  view.width = result.w;
  view.height = result.h;
  overlay.width = result.w;
  overlay.height = result.h;
  const ctx = view.getContext("2d");
  if (!ctx) return;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(result.data), result.w, result.h), 0, 0);
  drawOverlay();
  updateSizeReadout();
}

function drawOverlay(): void {
  const ctx = overlay.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!cropping || !selection) return;
  const { x, y, w, h } = selection;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, 0, overlay.width, overlay.height);
  ctx.clearRect(x, y, w, h);
  ctx.strokeStyle = "#4f8cff";
  ctx.lineWidth = Math.max(1, overlay.width / 400);
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
}

function updateSizeReadout(): void {
  if (!working) return;
  const { w, h } = outputSize(working.w, working.h, { scale: params.scale, rotateDeg: params.rotate });
  sizeReadout.textContent = `${w} × ${h} px`;
}

// ---------- crop ----------

function setCropping(on: boolean): void {
  cropping = on;
  if (on) setPicking(false);
  selection = null;
  dragStart = null;
  cropToggle.classList.toggle("active", on);
  checker.classList.toggle("cropping", on);
  cropApply.disabled = true;
  drawOverlay();
}

function canvasPoint(ev: PointerEvent): { x: number; y: number } {
  const r = view.getBoundingClientRect();
  return {
    x: ((ev.clientX - r.left) / r.width) * view.width,
    y: ((ev.clientY - r.top) / r.height) * view.height,
  };
}

view.addEventListener("pointerdown", (ev) => {
  if (!cropping) return;
  ev.preventDefault();
  view.setPointerCapture(ev.pointerId);
  dragStart = canvasPoint(ev);
  selection = null;
  cropApply.disabled = true;
});

view.addEventListener("pointermove", (ev) => {
  if (!cropping || !dragStart) return;
  const p = canvasPoint(ev);
  selection = clampRect(
    {
      x: Math.min(dragStart.x, p.x),
      y: Math.min(dragStart.y, p.y),
      w: Math.abs(p.x - dragStart.x),
      h: Math.abs(p.y - dragStart.y),
    },
    view.width,
    view.height,
  );
  drawOverlay();
});

view.addEventListener("pointerup", () => {
  if (!cropping || !dragStart) return;
  dragStart = null;
  cropApply.disabled = !selection || selection.w < 2 || selection.h < 2;
});

cropToggle.addEventListener("click", () => setCropping(!cropping));

cropApply.addEventListener("click", () => {
  if (!working || !selection || view.width === 0) return;
  // Bake current rotation into the working image, then crop in displayed coords.
  const fullRot = rotatePixels(working, params.rotate);
  const k = fullRot.w / view.width;
  const rect = clampRect(
    { x: selection.x * k, y: selection.y * k, w: selection.w * k, h: selection.h * k },
    fullRot.w,
    fullRot.h,
  );
  working = cropPixels(fullRot, rect);
  params.rotate = 0;
  sliders.rotate.value = "0";
  syncOutput(sliders.rotate);
  rebuildPreviewBase();
  setCropping(false);
  scheduleRender();
});

resetImage.addEventListener("click", () => {
  if (!original) return;
  working = clone(original);
  params = defaultParams();
  syncSlidersFromParams();
  setKey(null);
  setCropping(false);
  setPicking(false);
  rebuildPreviewBase();
  scheduleRender();
});

// ---------- color picking ----------

function setPicking(on: boolean): void {
  picking = on;
  if (on) setCropping(false);
  pickToggle.classList.toggle("active", on);
  checker.classList.toggle("picking", on);
}

function setKey(key: readonly [number, number, number] | null): void {
  params.key = key;
  keyClear.disabled = !key;
  keySwatch.style.background = key ? `rgb(${key[0]},${key[1]},${key[2]})` : "";
}

pickToggle.addEventListener("click", () => setPicking(!picking));
keyClear.addEventListener("click", () => {
  setKey(null);
  scheduleRender();
});

view.addEventListener("click", (ev) => {
  if (!picking || !pickBuffer) return;
  const p = canvasPoint(ev as PointerEvent);
  const x = Math.min(pickBuffer.w - 1, Math.max(0, Math.floor(p.x)));
  const y = Math.min(pickBuffer.h - 1, Math.max(0, Math.floor(p.y)));
  const i = (y * pickBuffer.w + x) * 4;
  const d = pickBuffer.data;
  setKey([d[i] as number, d[i + 1] as number, d[i + 2] as number]);
  setPicking(false);
  scheduleRender();
});

// ---------- sliders ----------

function syncOutput(input: HTMLInputElement): void {
  const out = input.parentElement?.querySelector("output");
  if (!out) return;
  if (input === sliders.rotate) out.textContent = `${input.value}°`;
  else if (input === sliders.scale) out.textContent = `${input.value}%`;
  else out.textContent = input.value;
}

function syncSlidersFromParams(): void {
  sliders.tol.value = String(Math.round((params.tol / TOL_MAX) * 100));
  sliders.feather.value = String(Math.round((params.feather / FEATHER_MAX) * 100));
  sliders.brightness.value = String(Math.round(params.brightness * 100));
  sliders.contrast.value = String(Math.round(params.contrast * 100));
  sliders.rotate.value = String(params.rotate);
  sliders.scale.value = String(Math.round(params.scale * 100));
  for (const s of Object.values(sliders)) syncOutput(s);
}

for (const [name, input] of Object.entries(sliders)) {
  input.addEventListener("input", () => {
    const v = Number(input.value);
    if (name === "tol") params.tol = (v / 100) * TOL_MAX;
    else if (name === "feather") params.feather = (v / 100) * FEATHER_MAX;
    else if (name === "brightness") params.brightness = v / 100;
    else if (name === "contrast") params.contrast = v / 100;
    else if (name === "rotate") params.rotate = v;
    else if (name === "scale") params.scale = v / 100;
    syncOutput(input);
    scheduleRender();
  });
}

// ---------- download ----------

downloadBtn.addEventListener("click", () => {
  if (!working) return;
  downloadBtn.disabled = true;
  downloadBtn.textContent = "Processing…";
  // Let the button repaint before the heavy synchronous pipeline runs.
  setTimeout(() => {
    try {
      const w = working;
      if (!w) return;
      const rotated = rotatePixels(w, params.rotate);
      const target = outputSize(w.w, w.h, { scale: params.scale, rotateDeg: params.rotate });
      const scaled =
        rotated.w === target.w && rotated.h === target.h ? rotated : scalePixels(rotated, target.w, target.h);
      applyBrightnessContrast(scaled.data, params.brightness, params.contrast);
      if (params.key) applyChromaKey(scaled.data, params.key, params.tol, params.feather);
      const c = document.createElement("canvas");
      c.width = scaled.w;
      c.height = scaled.h;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(scaled.data), scaled.w, scaled.h), 0, 0);
      c.toBlob((blob) => {
        if (blob) {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "makepng.png";
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        }
        downloadBtn.disabled = false;
        downloadBtn.textContent = "Download PNG";
      }, "image/png");
    } catch (err) {
      downloadBtn.disabled = false;
      downloadBtn.textContent = "Download PNG";
      throw err;
    }
  }, 20);
});

// ---------- input sources ----------

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" || ev.key === " ") fileInput.click();
});
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) void loadImage(f);
  fileInput.value = "";
});

for (const target of [dropzone, document.body]) {
  target.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    dropzone.classList.add("drag");
  });
  target.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
  target.addEventListener("drop", (ev) => {
    ev.preventDefault();
    dropzone.classList.remove("drag");
    const f = ev.dataTransfer?.files?.[0];
    if (f && f.type.startsWith("image/")) void loadImage(f);
  });
}

window.addEventListener("paste", (ev) => {
  const items = ev.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) void loadImage(f);
      return;
    }
  }
});
