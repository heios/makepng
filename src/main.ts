import "./style.css";
import { applyBrightnessContrast } from "./engine/adjust";
import { applyChromaKey } from "./engine/chroma";
import { srgbToLinear } from "./engine/gamma";
import { detectLocale, LOCALES, type Locale, type MessageKey } from "./i18n";
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
const SPREAD_MAX = 0.25; // spread slider 0..100 → 0..0.25 (reach of partial transparency for nearby colors)

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
const filesizeReadout = $<HTMLParagraphElement>("filesize-readout");
const downloadBtn = $<HTMLButtonElement>("download");
const themeSelect = $<HTMLSelectElement>("theme");
const langSelect = $<HTMLSelectElement>("lang");

// ---------- theme ----------

const THEME_KEY = "makepng-theme";

function applyTheme(v: string): void {
  if (v === "light" || v === "dark") document.documentElement.dataset["theme"] = v;
  else delete document.documentElement.dataset["theme"]; // auto: follow the OS
}

try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") themeSelect.value = saved;
} catch {
  /* storage unavailable: stay on auto */
}
applyTheme(themeSelect.value);

themeSelect.addEventListener("change", () => {
  const v = themeSelect.value;
  applyTheme(v);
  try {
    if (v === "light" || v === "dark") localStorage.setItem(THEME_KEY, v);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* ignore */
  }
});

// ---------- language ----------

const LANG_KEY = "makepng-lang";
const LOCALE_CODES = LOCALES.map((l) => l.code);
const EN = LOCALES.find((l) => l.code === "en") as Locale;

// Populate the picker: Auto + native names (native names are never translated).
{
  const autoOpt = document.createElement("option");
  autoOpt.value = "auto";
  autoOpt.dataset["i18n"] = "auto";
  autoOpt.textContent = "Auto";
  langSelect.append(autoOpt);
  for (const l of LOCALES) {
    const o = document.createElement("option");
    o.value = l.code;
    o.textContent = l.name;
    langSelect.append(o);
  }
  langSelect.value = "auto";
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved && LOCALE_CODES.includes(saved)) langSelect.value = saved;
  } catch {
    /* stay on auto */
  }
}

function activeLocale(): Locale {
  const v = langSelect.value;
  const code = v === "auto" ? detectLocale(navigator.languages ?? [navigator.language], LOCALE_CODES) : v;
  return LOCALES.find((l) => l.code === code) ?? EN;
}

function t(key: MessageKey): string {
  return activeLocale().messages[key];
}

function applyI18n(): void {
  const loc = activeLocale();
  document.documentElement.lang = loc.code;
  document.documentElement.dir = loc.rtl ? "rtl" : "ltr";
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-i18n]"))) {
    el.textContent = loc.messages[el.dataset["i18n"] as MessageKey];
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-i18n-title]"))) {
    el.title = loc.messages[el.dataset["i18nTitle"] as MessageKey];
  }
  filesizeReadout.dataset["recalc"] = ` ${loc.messages.recalculating}`;
  if (!downloadBtn.disabled) downloadBtn.textContent = loc.messages.download;
  updateFileSizeText();
}

langSelect.addEventListener("change", () => {
  try {
    if (langSelect.value === "auto") localStorage.removeItem(LANG_KEY);
    else localStorage.setItem(LANG_KEY, langSelect.value);
  } catch {
    /* ignore */
  }
  applyI18n();
});

const sliders = {
  tol: $<HTMLInputElement>("tol"),
  spread: $<HTMLInputElement>("spread"),
  brightness: $<HTMLInputElement>("brightness"),
  contrast: $<HTMLInputElement>("contrast"),
  rotate: $<HTMLInputElement>("rotate"),
  scale: $<HTMLInputElement>("scale"),
};

interface Params {
  tol: number;
  spread: number;
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

// Staged preview cache: geometry (rotate+scale) and adjust results are reused
// across renders so e.g. a spread drag never re-runs rotation.
let stage1: Pixels | null = null; // previewBase after rotate + scale
let stage2: Pixels | null = null; // stage1 after brightness/contrast
let geomDirty = true;
let adjustDirty = true;

function invalidateGeometry(): void {
  geomDirty = true;
}
function invalidateAdjust(): void {
  adjustDirty = true;
}

let cropping = false;
let picking = false;
let selection: Rect | null = null;
let dragStart: { x: number; y: number } | null = null;

function defaultParams(): Params {
  return { tol: 0.15 * TOL_MAX, spread: 0.1 * SPREAD_MAX, brightness: 0, contrast: 0, rotate: 0, scale: 1, key: null };
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
  invalidateGeometry();
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
  markFileSizeStale(); // every scheduled render corresponds to a change that can affect the final PNG
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render(): void {
  if (!previewBase || !working) return;
  if (geomDirty || !stage1) {
    let p = rotatePixels(previewBase, params.rotate);
    // Reflect the Resize slider in the preview, capped to PREVIEW_MAX.
    const target = outputSize(previewBase.w, previewBase.h, { scale: params.scale, rotateDeg: params.rotate });
    const k = Math.min(1, PREVIEW_MAX / Math.max(target.w, target.h));
    const tw = Math.max(1, Math.round(target.w * k));
    const th = Math.max(1, Math.round(target.h * k));
    if (tw !== p.w || th !== p.h) p = scalePixels(p, tw, th);
    stage1 = p;
    geomDirty = false;
    adjustDirty = true;
  }
  if (adjustDirty || !stage2) {
    stage2 = clone(stage1);
    applyBrightnessContrast(stage2.data, params.brightness, params.contrast);
    pickBuffer = stage2;
    adjustDirty = false;
  }
  let result = stage2;
  if (params.key) {
    result = clone(stage2);
    applyChromaKey(result.data, params.key, params.tol, params.spread);
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
  invalidateGeometry();
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
  invalidateGeometry();
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
  updateCheckerContrast(key);
}

/**
 * Make the transparency checkerboard contrast against the picked color, so
 * removed regions read clearly: light keys get a dark checker and vice versa
 * (split on linear-light luminance), both tinted toward the key's complement
 * for hue contrast. No key → theme defaults.
 */
function updateCheckerContrast(key: readonly [number, number, number] | null): void {
  if (!key) {
    checker.style.removeProperty("--check-a");
    checker.style.removeProperty("--check-b");
    return;
  }
  const y = 0.2126 * srgbToLinear(key[0]) + 0.7152 * srgbToLinear(key[1]) + 0.0722 * srgbToLinear(key[2]);
  const comp = [255 - key[0], 255 - key[1], 255 - key[2]] as const;
  const [gA, gB] = y > 0.25 ? [64, 44] : [232, 206];
  const mix = (g: number, c: number): number => Math.round(0.72 * g + 0.28 * c);
  checker.style.setProperty("--check-a", `rgb(${mix(gA, comp[0])},${mix(gA, comp[1])},${mix(gA, comp[2])})`);
  checker.style.setProperty("--check-b", `rgb(${mix(gB, comp[0])},${mix(gB, comp[1])},${mix(gB, comp[2])})`);
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
  sliders.spread.value = String(Math.round((params.spread / SPREAD_MAX) * 100));
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
    else if (name === "spread") params.spread = (v / 100) * SPREAD_MAX;
    else if (name === "brightness") {
      params.brightness = v / 100;
      invalidateAdjust();
    } else if (name === "contrast") {
      params.contrast = v / 100;
      invalidateAdjust();
    } else if (name === "rotate") {
      params.rotate = v;
      invalidateGeometry();
    } else if (name === "scale") {
      params.scale = v / 100;
      invalidateGeometry();
    }
    syncOutput(input);
    scheduleRender();
  });
}

// ---------- final PNG: size preview + download ----------

const SIZE_RECALC_DELAY = 500; // ms after the last change

let sizeRevision = 0;
let sizeTimer: number | undefined;
let cachedFinal: { rev: number; blob: Blob } | null = null;
let lastPngBytes: number | null = null;

function updateFileSizeText(): void {
  filesizeReadout.textContent = `${t("pngSize")} ${lastPngBytes === null ? "–" : formatBytes(lastPngBytes)}`;
}

/** Any change → the shown PNG size is stale; recalc 0.5 s after the last change. */
function markFileSizeStale(): void {
  sizeRevision++;
  cachedFinal = null;
  filesizeReadout.classList.add("stale");
  if (sizeTimer !== undefined) clearTimeout(sizeTimer);
  if (!working) return;
  sizeTimer = window.setTimeout(recalcFileSize, SIZE_RECALC_DELAY);
}

/** Full-resolution pipeline: crop(applied) → scale/rotate → adjust → chroma. */
function buildFinalPixels(): Pixels | null {
  const w = working;
  if (!w) return null;
  const target = outputSize(w.w, w.h, { scale: params.scale, rotateDeg: params.rotate });
  // When downscaling, scale BEFORE rotating so the expensive arbitrary-angle
  // rotation runs on the small buffer (a full-res 45° rotate of a 12 MP photo
  // would need hundreds of MB of accumulators). A final exact resample pins
  // the dimensions to the outputSize contract either way.
  let buf = w;
  if (params.scale < 1) {
    buf = scalePixels(w, Math.max(1, Math.round(w.w * params.scale)), Math.max(1, Math.round(w.h * params.scale)));
  }
  buf = rotatePixels(buf, params.rotate);
  if (buf.w !== target.w || buf.h !== target.h) buf = scalePixels(buf, target.w, target.h);
  applyBrightnessContrast(buf.data, params.brightness, params.contrast);
  if (params.key) applyChromaKey(buf.data, params.key, params.tol, params.spread);
  return buf;
}

function pixelsToBlob(p: Pixels, cb: (blob: Blob | null) => void): void {
  const c = document.createElement("canvas");
  c.width = p.w;
  c.height = p.h;
  const ctx = c.getContext("2d");
  if (!ctx) {
    cb(null);
    return;
  }
  ctx.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.w, p.h), 0, 0);
  c.toBlob(cb, "image/png");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Encode the final PNG for the current settings, reusing the cache when fresh. */
function ensureFinalBlob(cb: (blob: Blob | null) => void): void {
  if (cachedFinal && cachedFinal.rev === sizeRevision) {
    cb(cachedFinal.blob);
    return;
  }
  const rev = sizeRevision;
  const px = buildFinalPixels();
  if (!px) {
    cb(null);
    return;
  }
  pixelsToBlob(px, (blob) => {
    if (blob && rev === sizeRevision) {
      cachedFinal = { rev, blob };
      lastPngBytes = blob.size;
      updateFileSizeText();
      filesizeReadout.classList.remove("stale");
    }
    // If the settings changed mid-encode, markFileSizeStale already queued a
    // fresh recalc; this result is simply dropped.
    cb(blob && rev === sizeRevision ? blob : null);
  });
}

function recalcFileSize(): void {
  ensureFinalBlob(() => {});
}

downloadBtn.addEventListener("click", () => {
  if (!working) return;
  downloadBtn.disabled = true;
  downloadBtn.textContent = t("processing");
  // Let the button repaint before the heavy synchronous pipeline runs.
  const finish = (blob: Blob | null, retry: boolean): void => {
    if (blob) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "makepng.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } else if (retry && working) {
      // Settings changed while encoding — encode once more with the new ones.
      ensureFinalBlob((b) => finish(b, false));
      return;
    }
    downloadBtn.disabled = false;
    downloadBtn.textContent = t("download");
  };
  setTimeout(() => ensureFinalBlob((blob) => finish(blob, true)), 20);
});

// ---------- input sources ----------

function tryLoad(source: Blob): void {
  loadImage(source).catch(() => {
    alert(t("decodeError"));
  });
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" || ev.key === " ") fileInput.click();
});
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) tryLoad(f);
  fileInput.value = "";
});

// Drag highlight only on the dropzone (with a relatedTarget check to avoid
// child-element dragleave flicker); body handlers just enable dropping anywhere.
dropzone.addEventListener("dragover", (ev) => {
  ev.preventDefault();
  dropzone.classList.add("drag");
});
dropzone.addEventListener("dragleave", (ev) => {
  if (!(ev.relatedTarget instanceof Node) || !dropzone.contains(ev.relatedTarget)) {
    dropzone.classList.remove("drag");
  }
});
document.body.addEventListener("dragover", (ev) => ev.preventDefault());
for (const target of [dropzone, document.body]) {
  target.addEventListener("drop", (ev) => {
    ev.preventDefault();
    dropzone.classList.remove("drag");
    const f = ev.dataTransfer?.files?.[0];
    if (f && f.type.startsWith("image/")) tryLoad(f);
  });
}

window.addEventListener("paste", (ev) => {
  const items = ev.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) tryLoad(f);
      return;
    }
  }
});

// ---------- init ----------

applyI18n();
