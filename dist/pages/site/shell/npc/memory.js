// web/npc/memory.js
// Per-NPC, per-playthrough conversation memory for the web NPC chat layer.
//
// SPEC (human request, simplified)
//  - Playthrough id: a UUID in localStorage under `npcmem:active`, created on
//    first use. "New playthrough / forget all" clears the CURRENT playthrough's
//    records. There is NO save export/import integration.
//  - Key: `npcmem:<pid>:<identity>`. The identity comes from cards/index.js
//    speakerIdentity(): `npc<class>` for permanent NPCs, else `obj<objId>:c<class>`.
//    NEVER keyed by shape.
//  - Avatar guard: the speaker-0 / main-actor objId is NEVER stored as an NPC,
//    and avatar barks are filtered out of "heard".
//  - Per-NPC record: last 8 turns verbatim; a rolling summary <= 600 chars,
//    updated from the model's optional `memory_note` (no extra call); up to 12
//    short facts; first-met and last-met timestamps.
//  - Persistence: survives leaving/returning and a browser reload.
//  - Reset: new playthrough -> fresh memory; settings offer "Forget this NPC"
//    and "Forget all NPC memory for this playthrough".
//  - Cap: 2 MB total. Beyond it, the OLDEST NPC records are trimmed to their
//    summary only (turns and facts replaced by the summary), oldest first.
//
// The module is pure: it takes a storage-like object (getItem/setItem/
// removeItem/key/length) so Node tests can drive it with a fake, and the browser
// can hand it localStorage.

export const ACTIVE_KEY = "npcmem:active";
export const PREFIX = "npcmem:";

export const MAX_TURNS = 8;
export const MAX_SUMMARY_CHARS = 600;
export const MAX_FACTS = 12;
export const MAX_FACT_CHARS = 120;
export const STORAGE_CAP_BYTES = 2 * 1024 * 1024; // 2 MB

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

// RFC4122 v4 UUID. Uses crypto.getRandomValues when available, else Math.random
// (Node tests / old browsers). Never returns a hardcoded value.
export function uuidv4(cryptoObj = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export function isValidPlaythroughId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function safeStorage(storage) {
  if (!storage) return null;
  if (typeof storage.getItem !== "function") return null;
  return storage;
}

function readRaw(storage, key) {
  const s = safeStorage(storage);
  if (!s) return null;
  try { return s.getItem(key); } catch { return null; }
}

function writeRaw(storage, key, value) {
  const s = safeStorage(storage);
  if (!s) return false;
  try { s.setItem(key, value); return true; } catch { return false; }
}

function removeRaw(storage, key) {
  const s = safeStorage(storage);
  if (!s || typeof s.removeItem !== "function") return false;
  try { s.removeItem(key); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// playthrough id
// ---------------------------------------------------------------------------

// Read the active playthrough id, creating one on first use. `create` may be
// overridden by tests to make the id deterministic.
export function getPlaythroughId(storage, create = uuidv4) {
  const existing = readRaw(storage, ACTIVE_KEY);
  if (isValidPlaythroughId(existing)) return existing.trim();
  const id = create();
  writeRaw(storage, ACTIVE_KEY, id);
  return id;
}

// Start a fresh playthrough: a NEW id. Records belonging to OTHER playthroughs
// are left strictly untouched — only the ACTIVE pointer moves.
export function newPlaythrough(storage, create = uuidv4) {
  const id = create();
  writeRaw(storage, ACTIVE_KEY, id);
  return id;
}

// Force the active id.
export function setPlaythroughId(storage, id) {
  if (!isValidPlaythroughId(id)) return false;
  return writeRaw(storage, ACTIVE_KEY, id.trim());
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

export function memoryKey(playthroughId, identity) {
  return `${PREFIX}${playthroughId}:${identity}`;
}

function parseMemoryKey(key) {
  if (typeof key !== "string" || !key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  return { playthroughId: rest.slice(0, sep), identity: rest.slice(sep + 1) };
}

// ---------------------------------------------------------------------------
// record shape
// ---------------------------------------------------------------------------

export function emptyRecord(now = Date.now()) {
  return {
    v: 1,
    turns: [],            // {role, text, at} — verbatim, capped at MAX_TURNS
    summary: "",          // <= MAX_SUMMARY_CHARS
    facts: [],            // short strings, capped at MAX_FACTS
    firstMet: now,
    lastMet: now,
  };
}

function clampText(value, max) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max);
}

// A rolling summary: newest note appended, whole thing clamped to 600 chars.
// Trimming keeps the most RECENT material (the tail).
export function mergeSummary(previous, note) {
  const add = clampText(note, MAX_SUMMARY_CHARS);
  if (!add) return clampText(previous, MAX_SUMMARY_CHARS);
  const prev = clampText(previous, MAX_SUMMARY_CHARS);
  const joined = prev ? `${prev} ${add}` : add;
  return joined.length <= MAX_SUMMARY_CHARS ? joined : joined.slice(joined.length - MAX_SUMMARY_CHARS);
}

// Facts are short and de-duplicated case-insensitively.
export function mergeFacts(previous, incoming) {
  const out = Array.isArray(previous) ? previous.map((f) => clampText(f, MAX_FACT_CHARS)).filter(Boolean) : [];
  const list = Array.isArray(incoming) ? incoming : (incoming ? [incoming] : []);
  for (const raw of list) {
    const fact = clampText(raw, MAX_FACT_CHARS);
    if (!fact) continue;
    const lower = fact.toLowerCase();
    const at = out.findIndex((f) => f.toLowerCase() === lower);
    if (at >= 0) out.splice(at, 1);
    out.push(fact);
  }
  return out.slice(-MAX_FACTS);
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export function createMemoryStore(storage, options = {}) {
  const u16 = (str) => String(str ?? "").length * 2; // localStorage quota is UTF-16 code units x2 bytes
  const now = options.now ?? (() => Date.now());
  const create = options.createId ?? uuidv4;
  const cap = Number.isFinite(options.capBytes) ? options.capBytes : STORAGE_CAP_BYTES;

  function read(playthroughId, identity) {
    const key = memoryKey(playthroughId, identity);
    const text = readRaw(storage, key);
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") return null;
      return {
        ...emptyRecord(now()),
        ...parsed,
        turns: Array.isArray(parsed.turns) ? parsed.turns.slice(-MAX_TURNS) : [],
        facts: Array.isArray(parsed.facts) ? parsed.facts.slice(-MAX_FACTS) : [],
        summary: clampText(parsed.summary, MAX_SUMMARY_CHARS),
      };
    } catch { return null; }
  }

  function write(playthroughId, identity, record) {
    const key = memoryKey(playthroughId, identity);
    const ok = writeRaw(storage, key, JSON.stringify(record));
    if (ok) enforceCap(playthroughId);
    return ok;
  }

  // Get-or-create. `identity` is a `npc<class>` / `obj<objId>:c<class>` token
  // (see cards/index.js speakerIdentity); it is never a name or a shape.
  function ensure(playthroughId, identity) {
    const existing = read(playthroughId, identity);
    if (existing) return existing;
    const fresh = emptyRecord(now());
    write(playthroughId, identity, fresh);
    return fresh;
  }

  function recordTurn(playthroughId, identity, role, text) {
    const rec = ensure(playthroughId, identity);
    const turn = { role: role === "npc" ? "npc" : "player", text: clampText(text, 2000), at: now() };
    rec.turns = [...rec.turns, turn].slice(-MAX_TURNS);
    rec.lastMet = turn.at;
    write(playthroughId, identity, rec);
    return rec;
  }

  // Apply a model reply: turns + optional memory_note (summary) + facts.
  function applyReply(playthroughId, identity, { playerText, replyText, memoryNote, facts } = {}) {
    let rec = ensure(playthroughId, identity);
    if (playerText) rec = recordTurn(playthroughId, identity, "player", playerText);
    if (replyText) rec = recordTurn(playthroughId, identity, "npc", replyText);
    rec.summary = mergeSummary(rec.summary, memoryNote);
    rec.facts = mergeFacts(rec.facts, facts);
    write(playthroughId, identity, rec);
    return rec;
  }

  function forget(playthroughId, identity) {
    return removeRaw(storage, memoryKey(playthroughId, identity));
  }

  function forgetAll(playthroughId) {
    return clearPlaythrough(storage, playthroughId);
  }

  function listKeys(playthroughId) {
    const s = safeStorage(storage);
    if (!s || typeof s.key !== "function") return [];
    const out = [];
    const len = Number(s.length ?? 0);
    for (let i = 0; i < len; i += 1) {
      let key = null;
      try { key = s.key(i); } catch { key = null; }
      const parsed = parseMemoryKey(key);
      if (parsed && parsed.playthroughId === playthroughId) out.push(key);
    }
    return out;
  }

  function byteSize() {
    const s = safeStorage(storage);
    if (!s || typeof s.key !== "function") return 0;
    let total = 0;
    const len = Number(s.length ?? 0);
    for (let i = 0; i < len; i += 1) {
      let key = null;
      try { key = s.key(i); } catch { key = null; }
      if (!key || !key.startsWith(PREFIX)) continue;
      total += u16(key) + u16(readRaw(storage, key));
    }
    return total;
  }

  // Storage cap: when the npcmem footprint exceeds `cap`, the OLDEST NPC
  // records (by lastMet) have their turns and facts replaced by the summary
  // until we fit. Trimming runs oldest-first and stops as soon as we are under
  // the cap.
  function enforceCap(playthroughId) {
    if (!Number.isFinite(cap) || cap <= 0) return { trimmed: 0 };
    let total = byteSize();
    if (total <= cap) return { trimmed: 0 };

    const entries = [];
    const s = safeStorage(storage);
    if (s && typeof s.key === "function") {
      const len = Number(s.length ?? 0);
      for (let i = 0; i < len; i += 1) {
        let key = null;
        try { key = s.key(i); } catch { key = null; }
        const parsed = parseMemoryKey(key);
        if (!parsed) continue;
        if (playthroughId && parsed.playthroughId !== playthroughId) continue;
        const rec = read(parsed.playthroughId, parsed.identity);
        entries.push({ key, parsed, lastMet: rec?.lastMet ?? 0 });
      }
    }
    entries.sort((a, b) => a.lastMet - b.lastMet);

    let trimmed = 0;
    for (const entry of entries) {
      if (total <= cap) break;
      const rec = read(entry.parsed.playthroughId, entry.parsed.identity);
      if (!rec) continue;
      // Already summary-only: nothing left to trim.
      if (rec.turns.length === 0 && rec.facts.length === 0) continue;
      const beforeText = readRaw(storage, entry.key) ?? "";
      const slim = { v: 1, turns: [], facts: [], summary: rec.summary, firstMet: rec.firstMet, lastMet: rec.lastMet };
      const text = JSON.stringify(slim);
      if (u16(text) >= u16(beforeText)) continue;
      writeRaw(storage, entry.key, text);
      total -= Math.max(0, u16(beforeText) - u16(text));
      trimmed += 1;
    }
    return { trimmed };
  }

  return {
    read, write, ensure, recordTurn, applyReply, forget, forgetAll,
    listKeys, byteSize, enforceCap, getPlaythroughId: (createId) => getPlaythroughId(storage, createId ?? create),
    newPlaythrough: (createId) => newPlaythrough(storage, createId ?? create),
  };
}

// Remove every record belonging to a playthrough. Used by new-game and the
// "forget all" setting.
export function clearPlaythrough(storage, playthroughId) {
  const s = safeStorage(storage);
  if (!s || typeof s.key !== "function" || !isValidPlaythroughId(playthroughId)) return 0;
  const target = String(playthroughId).trim();
  const keys = [];
  const len = Number(s.length ?? 0);
  for (let i = 0; i < len; i += 1) {
    let key = null;
    try { key = s.key(i); } catch { key = null; }
    const parsed = parseMemoryKey(key);
    if (parsed && parsed.playthroughId === target) keys.push(key);
  }
  for (const key of keys) removeRaw(storage, key);
  return keys.length;
}
