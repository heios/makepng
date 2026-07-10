import { describe, expect, it } from "vitest";
import { detectLocale, LOCALES } from "../src/i18n";

const codes = LOCALES.map((l) => l.code);

describe("LOCALES", () => {
  it("contains exactly 20 languages, including English", () => {
    expect(LOCALES.length).toBe(20);
    expect(codes).toContain("en");
  });

  it("has unique codes and native names", () => {
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(LOCALES.map((l) => l.name)).size).toBe(LOCALES.length);
  });

  it("covers the Ethnologue top-20 set (Arabic variants folded into ar)", () => {
    const expected = [
      "en", "zh", "hi", "es", "ar", "fr", "bn", "pt", "id", "ur",
      "ru", "de", "ja", "pcm", "mr", "vi", "te", "sw", "ha", "tr",
    ];
    expect([...codes].sort()).toEqual([...expected].sort());
  });

  it("every locale has every message key, non-empty", () => {
    const en = LOCALES.find((l) => l.code === "en");
    expect(en).toBeDefined();
    const keys = Object.keys(en!.messages);
    expect(keys.length).toBeGreaterThan(20);
    for (const locale of LOCALES) {
      for (const k of keys) {
        const v = (locale.messages as unknown as Record<string, string>)[k];
        expect(v, `${locale.code}.${k}`).toBeTruthy();
      }
    }
  });

  it("marks Arabic and Urdu as right-to-left", () => {
    for (const l of LOCALES) {
      if (l.code === "ar" || l.code === "ur") expect(l.rtl).toBe(true);
      else expect(l.rtl).toBeUndefined();
    }
  });
});

describe("detectLocale", () => {
  it("matches an exact code", () => {
    expect(detectLocale(["de"], codes)).toBe("de");
  });

  it("matches by primary subtag for regional variants", () => {
    expect(detectLocale(["pt-BR"], codes)).toBe("pt");
    expect(detectLocale(["zh-TW"], codes)).toBe("zh");
    expect(detectLocale(["es-419"], codes)).toBe("es");
  });

  it("is case-insensitive", () => {
    expect(detectLocale(["ZH-CN"], codes)).toBe("zh");
  });

  it("respects preference order, skipping unavailable languages", () => {
    expect(detectLocale(["cy", "fr", "de"], codes)).toBe("fr");
  });

  it("falls back to English when nothing matches or the list is empty", () => {
    expect(detectLocale(["cy", "eu"], codes)).toBe("en");
    expect(detectLocale([], codes)).toBe("en");
  });
});
