// shell/ui/music.js
// Enhanced-instrument (General MIDI) support: the approved SoundFonts are
// fetched lazily (byte progress + real cancellation), verified byte-for-byte,
// cached (Cache Storage where available, IndexedDB as the fallback for a
// plain-HTTP LAN origin where Cache Storage is absent) and then handed to the
// engine's own setSoundFont. Nothing here fakes readiness: the achieved state
// comes only from the engine's own audio() accessor.
//
// Pure ES module (no DOM/BOM at import): fetch/caches/indexedDB/crypto are read
// from an injected env so the Node suites can exercise the verification, the
// cache fallback, the refetch-on-corruption and the abort path without a
// browser.

export const FONT_VERSION = 1;
export const FONT_CACHE_NAME = "ultima8-fonts-v1";

// The two Settings>Music sources. "fm" is the original score on the engine's
// built-in FM driver (option 0); "gm" is the SAME original score performed on
// General MIDI instruments (option 1) once a SoundFont is staged.
export const MUSIC_SOURCE = Object.freeze({ FM: "fm", GM: "gm" });

export function musicSourceOptionValue(source) {
  return source === MUSIC_SOURCE.GM ? 1 : 0;
}

// Approved SoundFonts. The URLs are engine-root mount points; the byte count and
// SHA-256 are the approved identities, recorded so a truncated, empty or
// tampered download is rejected before it is ever staged. GeneralUser is the
// full recommended desktop bank (~32 MB); TimGM6mb is the small mobile bank.
export const FONTS = Object.freeze({
  generaluser: Object.freeze({
    id: "generaluser",
    url: "/fonts/GeneralUser-GS.sf2",
    bytes: 32319396,
    sha256: "9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe",
  }),
  timgm6mb: Object.freeze({
    id: "timgm6mb",
    url: "/fonts/TimGM6mb.sf2",
    bytes: 5969788,
    sha256: "c5378b62028c920cb11e4803327983fee2f2cdff5dc89c708e39da417e51c854",
  }),
});

// Recommended font for this device: mobile UA, or a coarse primary pointer that
// also reports touch points, or a low-memory device gets the small bank;
// everything else gets the full GeneralUser bank. The viewport is never read.
// The platform facts used to pick a font and to reach a byte cache. Kept here
// so the app module stays wiring-only.
export function musicEnv(win = {}) {
  const nav = win.navigator ?? {};
  let coarse = false;
  try { coarse = win.matchMedia?.("(pointer: coarse)")?.matches === true; } catch { coarse = false; }
  return {
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints,
    deviceMemory: nav.deviceMemory,
    coarsePointer: coarse,
    caches: win.caches ?? null,
    indexedDB: win.indexedDB ?? null,
    crypto: win.crypto ?? (typeof crypto !== "undefined" ? crypto : null),
    fetch: win.fetch ?? (typeof fetch !== "undefined" ? fetch : null),
    baseUrl: win.location?.origin ?? "",
  };
}

export function chooseFontId(env = {}) {
  const ua = String(env.userAgent ?? "");
  const coarse = env.coarsePointer === true;
  const maxTouchPoints = Number(env.maxTouchPoints ?? 0) || 0;
  const deviceMemory = Number(env.deviceMemory);
  const mobileUA = /Android|iPhone|iPad|iPod|iOS/i.test(ua);
  const lowMemory = Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= 4;
  if (mobileUA || (coarse && maxTouchPoints > 0) || lowMemory) return FONTS.timgm6mb.id;
  return FONTS.generaluser.id;
}

export function fontFor(id) {
  return FONTS[id] ?? FONTS.generaluser;
}

// Cache keys are keyed by font identity AND version, so a re-approved font or a
// format bump never serves stale bytes.
export function fontCacheKey(font, version = FONT_VERSION) {
  return `ultima8.font.${font.id}.v${version}.sf2`;
}

function toHex(buf) {
  const b = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < b.length; i += 1) out += b[i].toString(16).padStart(2, "0");
  return out;
}

function sha256Hex(cryptoObj, bytes) {
  return cryptoObj.subtle.digest("SHA-256", bytes).then(toHex);
}

// Verify the exact approved bytes: length, the RIFF/SoundFont header
// (RIFF at offset 0, sfbk at offset 8) and, when the platform exposes
// crypto.subtle, the full SHA-256. Every failure is a returned {ok:false}
// object — this never throws, so a plain-HTTP LAN origin without crypto.subtle
// (or a bogus body) degrades to the size + header check instead of crashing.
export async function validateFontBytes(font, bytes, env = {}) {
  const data = bytes instanceof Uint8Array ? bytes : null;
  if (!data) return { ok: false, reason: "not a byte array" };
  const expected = Number(font?.bytes) || 0;
  if (data.byteLength !== expected) {
    return { ok: false, reason: `size mismatch (${data.byteLength} != ${expected})` };
  }
  if (data.byteLength < 12 || String.fromCharCode(...data.slice(0, 4)) !== "RIFF"
    || String.fromCharCode(...data.slice(8, 12)) !== "sfbk") {
    return { ok: false, reason: "not a RIFF/SoundFont file" };
  }
  const cryptoObj = env.crypto ?? (typeof crypto !== "undefined" ? crypto : null);
  if (cryptoObj && cryptoObj.subtle && typeof cryptoObj.subtle.digest === "function" && font.sha256) {
    let hex = null;
    try { hex = await sha256Hex(cryptoObj, data); } catch { hex = null; }
    if (hex && hex !== font.sha256) return { ok: false, reason: "SHA-256 mismatch" };
  }
  return { ok: true, reason: null };
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

// A real byte cache with Cache Storage first and IndexedDB as the fallback. On a
// plain-HTTP LAN origin (phone over http://192.168.x.x) `caches` does not
// exist, so the IDB path is what makes ordinary-phone LAN work at all.
export function createFontStore(env = {}) {
  const cachesApi = env.caches ?? (typeof caches !== "undefined" ? caches : null);
  const idbFactory = env.indexedDB ?? (typeof indexedDB !== "undefined" ? indexedDB : null);
  const base = String(env.baseUrl ?? (typeof location !== "undefined" ? location.origin : "http://localhost")).replace(/\/+$/, "");
  const dbName = "ultima8-fonts";
  const storeName = "fonts";
  const entryUrl = (key) => `${base}/__u8_font_cache/${key}`;

  function openDb() {
    if (!idbFactory || typeof idbFactory.open !== "function") return Promise.reject(new Error("IndexedDB unavailable"));
    return new Promise((resolve, reject) => {
      const req = idbFactory.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    try {
      const tx = db.transaction(storeName, "readonly");
      const val = await idbRequest(tx.objectStore(storeName).get(key));
      return val ?? null;
    } finally { try { db.close?.(); } catch { /* ignore */ } }
  }

  async function idbPut(key, bytes) {
    const db = await openDb();
    try {
      const tx = db.transaction(storeName, "readwrite");
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      tx.objectStore(storeName).put(ab, key);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
    } finally { try { db.close?.(); } catch { /* ignore */ } }
  }

  async function idbDel(key) {
    const db = await openDb();
    try {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
    } finally { try { db.close?.(); } catch { /* ignore */ } }
  }

  async function get(font) {
    const key = fontCacheKey(font);
    if (cachesApi && typeof cachesApi.open === "function") {
      try {
        const cache = await cachesApi.open(FONT_CACHE_NAME);
        const hit = await cache.match(entryUrl(key));
        if (hit) {
          const buf = await hit.arrayBuffer();
          if (buf.byteLength > 0) return new Uint8Array(buf);
        }
      } catch { /* Cache Storage absent/denied: fall through to IndexedDB */ }
    }
    if (idbFactory && typeof idbFactory.open === "function") {
      try {
        const v = await idbGet(key);
        if (v && v.byteLength > 0) return v instanceof Uint8Array ? v : new Uint8Array(v);
      } catch { /* no cache */ }
    }
    return null;
  }

  async function put(font, bytes) {
    const key = fontCacheKey(font);
    const copy = bytes.slice();
    let stored = false;
    if (cachesApi && typeof cachesApi.open === "function") {
      try {
        const cache = await cachesApi.open(FONT_CACHE_NAME);
        await cache.put(entryUrl(key), new Response(copy, { headers: { "x-u8-font": key } }));
        stored = true;
      } catch { /* fall through to IndexedDB */ }
    }
    if (idbFactory && typeof idbFactory.open === "function") {
      try { await idbPut(key, copy); stored = true; } catch { /* nothing more to do */ }
    }
    return stored;
  }

  async function remove(font) {
    const key = fontCacheKey(font);
    if (cachesApi && typeof cachesApi.open === "function") {
      try { const cache = await cachesApi.open(FONT_CACHE_NAME); await cache.delete(entryUrl(key)); } catch { /* ignore */ }
    }
    if (idbFactory && typeof idbFactory.open === "function") {
      try { await idbDel(key); } catch { /* ignore */ }
    }
  }

  return {
    get,
    put,
    remove,
    keyOf: (font) => fontCacheKey(font),
    has: async (font) => (await get(font)) !== null,
  };
}

// Fetch a SoundFont with byte progress and real cancellation. Streams the body
// when the platform supports it; falls back to a single arrayBuffer() read.
// Rejects an empty download so a truncated font is never staged.
export function fetchFont(font, opts = {}) {
  const fetchImpl = opts.fetch ?? (typeof fetch !== "undefined" ? fetch : null);
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const signal = opts.signal;
  if (typeof fetchImpl !== "function") return Promise.reject(new Error("instrument download is unavailable"));
  const expected = Number(font.bytes) || 0;
  onProgress({ received: 0, total: expected, ratio: 0 });
  return Promise.resolve(fetchImpl(font.url, { signal, cache: "no-store" })).then(async (res) => {
    if (!res || res.ok === false || (typeof res.status === "number" && (res.status < 200 || res.status >= 300))) {
      throw new Error(`instrument download failed (HTTP ${res?.status ?? "?"})`);
    }
    const declared = Number(res.headers?.get?.("content-length")) || expected;
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        chunks.push(chunk);
        received += chunk.byteLength;
        onProgress({ received, total: declared, ratio: declared ? Math.min(1, received / declared) : 0 });
      }
      if (received === 0) throw new Error("instrument download was empty");
      const out = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.byteLength; }
      onProgress({ received, total: declared || received, ratio: 1 });
      return out;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0) throw new Error("instrument download was empty");
    onProgress({ received: buf.byteLength, total: declared || buf.byteLength, ratio: 1 });
    return buf;
  });
}

// Cache-first download with verification. A cached copy that fails verification
// is dropped and refetched; the freshly fetched bytes must verify before they
// are stored. Returns {bytes, fromCache, refetched}. The caller clears its
// "downloading" flag in a finally — this resolves only after the last progress
// tick, so a stuck spinner is impossible.
export async function downloadFont(font, opts = {}) {
  const store = opts.store ?? null;
  const verify = (bytes) => validateFontBytes(font, bytes, opts);
  let refetched = false;
  if (store) {
    let cached = null;
    try { cached = await store.get(font); } catch { cached = null; }
    if (cached) {
      const check = await verify(cached);
      if (check.ok) return { bytes: cached, fromCache: true, refetched: false };
      refetched = true;                 // cached copy was corrupt/truncated
      try { await store.remove(font); } catch { /* best effort */ }
    }
  }
  const bytes = await fetchFont(font, opts);
  const check = await verify(bytes);
  if (!check.ok) throw new Error(`the downloaded instruments were invalid (${check.reason})`);
  if (store) { try { await store.put(font, bytes); } catch { /* caching is best-effort */ } }
  return { bytes, fromCache: false, refetched };
}

// Achieved General MIDI requires BOTH the live GM driver (synth 2) AND a font
// the engine actually finished loading; the preference/download is not proof.
export function isGmAchieved(audio) {
  return Number(audio?.synth) === 2 && Number(audio?.fontLoaded) === 1;
}

// The pure state machine behind the Settings>Music panel. `source` is the
// effective (Classic-derived) music source, never the raw stored preference.
export function musicPanelState(input = {}) {
  const { audio, source, staged, downloading, progress, error } = input;
  if (isGmAchieved(audio)) return { kind: "achieved" };
  if (downloading) return { kind: "downloading", ratio: Number(progress) || 0 };
  if (error) return { kind: "failed", error: String(error) };
  if (source === MUSIC_SOURCE.GM && staged) return { kind: "restart" };
  if (source === MUSIC_SOURCE.GM) return { kind: "prompt" };
  return { kind: "fm" };
}

// Save + restart is only allowed on a real, movable world (STASIS 0): the
// engine must actually own a live game to save and resume.
export function canRestartForMusic(input = {}) {
  return input.mode === "real" && input.isWorld === true && input.worldPlayable === true;
}
