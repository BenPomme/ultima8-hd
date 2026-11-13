// web/npc/bridge-adapter.js
// Reads the native NPC state and admits a canonical option selection.
//
// The engine lives in a SAME-ORIGIN iframe: `iframe[data-test=engine]`. Its
// Emscripten Module publishes the native NPC exports:
//   Module._u8npc_get_state()        -> char* to a JSON string
//   Module._u8npc_select_option(i)   -> int (1 admitted)
// and the Emscripten decoder UTF8ToString is reachable as a global inside the
// frame. The real host QA obtains both via iframe.contentWindow.eval(...), so we
// resolve them the same way: `contentWindow.eval('Module')` and
// `contentWindow.eval('UTF8ToString')`. There is NO Ultima8Bridge alias and NO
// Module.UTF8ToString property in this build — do not reference either.
//
// Nothing here guesses ids or names: it reads exactly the published fields and
// reports what is missing as a visible GAP instead of inventing a value.
//
// Published state (u8npc_get_state):
//   {askOpen, speakerObjId, speakerShape, speakerClass, permanentNpc,
//    speakerName?, speakerSource?, avatarObjId, options:[string],
//    recentBarks:[{objId,text}]}

export const ENGINE_FRAME_SELECTOR = "iframe[data-test=engine]";
export const BRIDGE_MODULE_NAME = "Module";

// Resolve the engine iframe and its Emscripten Module. Returns null when the
// frame is missing, cross-origin, or the Module has not been published yet.
export function resolveEngine(doc = globalThis.document) {
  try {
    const frame = doc?.querySelector?.(ENGINE_FRAME_SELECTOR);
    const win = frame?.contentWindow ?? null;
    if (!win) return null;
    const mod = win[BRIDGE_MODULE_NAME];
    if (!mod || typeof mod !== "object") return null;
    return { frame, win, mod };
  } catch { return null; }
}

// Resolve the Emscripten UTF8 decoder from the frame. In this build it is a
// global function reachable through contentWindow.eval('UTF8ToString'), NOT a
// property of Module. Returns null when it is not yet available.
// Resolution order: Module.UTF8ToString (if exported), window global, then eval of the
// Emscripten global. The first function found wins; null means not ready.
export function resolveDecoder(win) {
  if (!win) return null;
  try { const f = win[BRIDGE_MODULE_NAME]?.UTF8ToString; if (typeof f === "function") return f; } catch {}
  try { const f = win.UTF8ToString; if (typeof f === "function") return f; } catch {}
  try {
    if (typeof win.eval === "function") {
      const f = win.eval("typeof UTF8ToString === 'function' ? UTF8ToString : null");
      if (typeof f === "function") return f;
    }
  } catch {}
  return null;
}

// Normalise the raw native state into the shape the rest of the module uses.
// Unknown/missing fields become null rather than a guess.
export function normalizeState(raw) {
  if (!raw || typeof raw !== "object") return null;
  const options = Array.isArray(raw.options) ? raw.options.map((o) => String(o)) : [];
  const barks = Array.isArray(raw.recentBarks)
    ? raw.recentBarks
      .filter((b) => b && typeof b === "object")
      .map((b) => ({ objId: b.objId === null || b.objId === undefined ? null : Number(b.objId), text: String(b.text ?? "") }))
      .filter((b) => b.text.trim())
    : [];
  const speakerClass = raw.speakerClass === null || raw.speakerClass === undefined ? null : Number(raw.speakerClass);
  return {
    askOpen: raw.askOpen === true,
    speakerObjId: raw.speakerObjId === null || raw.speakerObjId === undefined ? null : Number(raw.speakerObjId),
    speakerShape: raw.speakerShape ?? null,
    // The authoritative identity: usecode class (objId + 1024 for permanent
    // NPCs, else the shape). null when the native side did not publish it.
    speakerClass: Number.isFinite(speakerClass) ? speakerClass : null,
    permanentNpc: raw.permanentNpc === true,
    speakerName: raw.speakerName ?? null,
    speakerSource: raw.speakerSource ?? null,
    options,
    recentBarks: barks,
    avatarObjId: raw.avatarObjId ?? raw.mainActorObjId ?? raw.speaker0ObjId ?? null,
  };
}

// A reader bound to a document. Every method returns a plain result object.
export function createBridgeReader(doc = globalThis.document) {
  function state() {
    const resolved = resolveEngine(doc);
    if (!resolved) return { ok: false, error: "engine-frame-unavailable", state: null };
    const decoder = resolveDecoder(resolved.win);
    if (!decoder) return { ok: false, error: "utf8-decoder-unavailable", state: null };

    const fn = resolved.mod._u8npc_get_state;
    if (typeof fn !== "function") return { ok: false, error: "method-not-published", state: null };

    let raw;
    try {
      const ptr = fn();
      if (!ptr) return { ok: false, error: "state-null", state: null };
      const text = decoder(ptr);
      raw = typeof text === "string" ? JSON.parse(text) : text;
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err), state: null };
    }
    const normalized = normalizeState(raw);
    if (!normalized) return { ok: false, error: "state-unreadable", state: null };
    return { ok: true, error: null, state: normalized };
  }

  // Admit a canonical native option selection. `expectedOptions` is the list the
  // model's choice was computed against: if native now offers something else,
  // the choice is REFUSED rather than mis-applied.
  function selectOption(index, expectedOptions = null) {
    const resolved = resolveEngine(doc);
    if (!resolved) return { ok: false, error: "engine-frame-unavailable" };
    if (!Number.isInteger(index) || index < 0) return { ok: false, error: "bad-index" };

    if (Array.isArray(expectedOptions)) {
      const fresh = state();
      if (!fresh.ok) return { ok: false, error: fresh.error };
      if (!fresh.state.askOpen) return { ok: false, error: "ask-closed" };
      const same = fresh.state.options.length === expectedOptions.length
        && fresh.state.options.every((o, i) => o === expectedOptions[i]);
      if (!same) return { ok: false, error: "options-stale" };
      if (index >= fresh.state.options.length) return { ok: false, error: "index-out-of-range" };
    }

    const fn = resolved.mod._u8npc_select_option;
    if (typeof fn !== "function") return { ok: false, error: "method-not-published" };
    let value;
    try { value = fn(index); }
    catch (err) { return { ok: false, error: String(err?.message ?? err) }; }
    const admitted = value === 1 || value === true || value === undefined;
    return { ok: admitted, error: admitted ? null : "not-admitted", value };
  }

  return { state, selectOption };
}
