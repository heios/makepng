/**
 * localStorage with a time-to-live. Values are wrapped as `{ v, e }` where `e`
 * is an absolute expiry timestamp (epoch ms). Reads past the expiry — or of
 * malformed/legacy entries — return null and evict the entry, so a stale
 * preference silently falls back to the app's default (auto).
 *
 * Every access is guarded: private-mode or disabled storage throws on access,
 * and the app must keep working without persistence.
 */

/** Six months, treated as 182 days (26 weeks). */
export const SIX_MONTHS_MS = 182 * 24 * 60 * 60 * 1000;

interface Envelope {
  v: string;
  e: number; // expiry, epoch ms
}

function isEnvelope(x: unknown): x is Envelope {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Envelope).v === "string" &&
    typeof (x as Envelope).e === "number"
  );
}

/**
 * Read a value, or null if absent, expired, or unreadable. Expired/malformed
 * entries are removed as a side effect.
 */
export function getWithTTL(key: string, now: number = Date.now()): string | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null; // storage unavailable
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null; // malformed / legacy plain-string entry → evict below
  }
  if (!isEnvelope(parsed) || parsed.e <= now) {
    removeItem(key);
    return null;
  }
  return parsed.v;
}

/** Store a value that expires `ttl` ms from now (default six months). */
export function setWithTTL(key: string, value: string, ttl: number = SIX_MONTHS_MS, now: number = Date.now()): void {
  try {
    const env: Envelope = { v: value, e: now + ttl };
    localStorage.setItem(key, JSON.stringify(env));
  } catch {
    /* storage unavailable: preference just won't persist */
  }
}

/** Remove a stored value. */
export function removeItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
