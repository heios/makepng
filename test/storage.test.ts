import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWithTTL, removeItem, setWithTTL, SIX_MONTHS_MS } from "../src/storage";

// Minimal in-memory localStorage stand-in; toggle `throws` to simulate
// disabled/private-mode storage.
function installStorage(): { throws: boolean; map: Map<string, string> } {
  const state = { throws: false, map: new Map<string, string>() };
  const store: Storage = {
    get length() {
      return state.map.size;
    },
    clear: () => state.map.clear(),
    key: (i: number) => [...state.map.keys()][i] ?? null,
    getItem: (k: string) => {
      if (state.throws) throw new Error("blocked");
      return state.map.has(k) ? (state.map.get(k) as string) : null;
    },
    setItem: (k: string, v: string) => {
      if (state.throws) throw new Error("blocked");
      state.map.set(k, v);
    },
    removeItem: (k: string) => {
      if (state.throws) throw new Error("blocked");
      state.map.delete(k);
    },
  };
  vi.stubGlobal("localStorage", store);
  return state;
}

describe("TTL storage", () => {
  let state: ReturnType<typeof installStorage>;

  beforeEach(() => {
    state = installStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("SIX_MONTHS_MS is 182 days", () => {
    expect(SIX_MONTHS_MS).toBe(182 * 24 * 60 * 60 * 1000);
  });

  it("round-trips a value before expiry", () => {
    setWithTTL("k", "dark", SIX_MONTHS_MS, 1000);
    expect(getWithTTL("k", 1000)).toBe("dark");
    expect(getWithTTL("k", 1000 + SIX_MONTHS_MS - 1)).toBe("dark");
  });

  it("returns null and evicts once expired", () => {
    setWithTTL("k", "es", SIX_MONTHS_MS, 0);
    expect(getWithTTL("k", SIX_MONTHS_MS)).toBeNull(); // e <= now
    expect(state.map.has("k")).toBe(false);
  });

  it("defaults the TTL to six months", () => {
    const now = 5_000;
    setWithTTL("k", "light", undefined, now);
    const stored = JSON.parse(state.map.get("k") as string);
    expect(stored.e).toBe(now + SIX_MONTHS_MS);
  });

  it("returns null for a missing key", () => {
    expect(getWithTTL("nope")).toBeNull();
  });

  it("evicts malformed / legacy plain-string entries", () => {
    state.map.set("k", "dark"); // pre-TTL raw value
    expect(getWithTTL("k")).toBeNull();
    expect(state.map.has("k")).toBe(false);
  });

  it("removeItem deletes the entry", () => {
    setWithTTL("k", "fr");
    removeItem("k");
    expect(getWithTTL("k")).toBeNull();
  });

  it("never throws when storage is unavailable", () => {
    state.throws = true;
    expect(() => setWithTTL("k", "v")).not.toThrow();
    expect(getWithTTL("k")).toBeNull();
    expect(() => removeItem("k")).not.toThrow();
  });
});
