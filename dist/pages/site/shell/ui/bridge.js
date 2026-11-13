// shell/ui/bridge.js
// The single path from the shell to the real engine, speaking the authoritative
// E1 bridge contract (shell/contract/bridge-v1.json, copied byte-for-byte from
// .scratch/contracts/bridge-v1.json). There is NO postMessage envelope: the
// engine page is a SAME-ORIGIN iframe and the shell calls the engine's own JS
// facade (`iframe.contentWindow.Ultima8Bridge`) directly.
//
// Every method name, state index and message id the shell uses comes from the
// generated table in ui/contract.js. Nothing is invented; anything the contract
// does not expose is reported as a GAP in CHECKPOINT.md and degraded visibly in
// the UI rather than faked.
//
// Readiness has three explicit phases:
//   loading  — the iframe is mounted; poll contentWindow.Ultima8Bridge (timeout
//              + visible error). No engine call is made yet.
//   engine   — the facade exists and Module is live (`Module._bridge_ready` is a
//              function). The player may still be in the menu or name entry.
//   world    — the contract's READY state field is 1 (an initialised world).
// Gestures and game actions are only valid in `world`.
import { ACTIONS } from "../core/actions.js";
import {
  STATE, ACTION, GESTURE, MODE, EVENT, ENGINE_EVENT, CONTRACT_NAME, AUDIO_STATE,
} from "./contract.js";
import { ENGINE_IFRAME_URL } from "./config.js";
// [W3 click-move] The ONE constants location for W2's published numeric
// path-action IDs. Kept in the pure core/input module (see
// resolvePathActionIds); null until W2 publishes its findings, so the feature
// stays OFF and never guesses an ID.
import { PATH_ACTION_IDS, resolvePathActionIds } from "../core/input/clickmove.js";

export const PHASE = Object.freeze({
  LOADING: "loading",
  ENGINE: "engine",
  WORLD: "world",
  ERROR: "error",
});

export const DEFAULT_POLL_MS = 100;
// The wasm engine can take a while to boot on a cold cache. The host QA build
// is local, so 30s is generous without leaving a dead shell forever.
export const DEFAULT_CONNECT_TIMEOUT_MS = 30000;
export const DEFAULT_CONFIRM_TIMEOUT_MS = 3000;
// SAVE_RESULT / LOAD_RESULT arrive from the engine's own next-frame drain. If
// neither the ok event nor a failure shows up in this window the shell reports
// a visible timeout instead of waiting forever.
export const DEFAULT_RESULT_TIMEOUT_MS = 8000;

const RESULT_TYPES = Object.freeze(new Set([ENGINE_EVENT.SAVE_RESULT, ENGINE_EVENT.LOAD_RESULT]));

// Engine-event type -> feedback kind. The E2 event stream is LIVE (contract
// version 1.1): HIT/BLOCK/HURT/DEATH carry real per-role payloads. The mapping
// below reads the documented slots only — `c` is the damage/hpLost figure, and
// `a`/`b` swap roles per type — so an actor id can never be mistaken for damage
// (that was the E1 guess this replaces).
const COMBAT_KIND = Object.freeze({
  [ENGINE_EVENT.HIT]: "hit",
  [ENGINE_EVENT.BLOCK]: "block",
  [ENGINE_EVENT.HURT]: "hurt",
  [ENGINE_EVENT.DEATH]: "death",
});

function intOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Read the first present numeric key from a snapshot, for feature-detecting the
// additive v1.2 fields the shell depends on without hard-coding names that may
// move. Returns null when none is present (fields not published yet).
export function pickNumber(obj, names) {
  if (!obj || typeof obj !== "object") return null;
  for (const name of names) {
    const v = Number(obj[name]);
    if (Number.isFinite(v) && v !== 0) return v;
    if (obj[name] === 0) return 0;
  }
  return null;
}

// Pure, role-aware translation of one E2 engine event into the shape the
// feedback layer consumes. Slots are exactly the contract's by_type table:
//   HIT(1)   a=attackerId b=targetId c=damage         d=damageType
//   BLOCK(2) a=targetId   b=attackerId c=damageThrough d=damageType
//   HURT(3)  a=targetId   b=attackerId c=hpLost       d=hpAfter
//   DEATH(4) a=targetId   b=attackerId c=damage       d=damageType
// `byPlayer` is only asserted when the caller can supply the controlled actor
// id; otherwise it is left null (never guessed). Returns null for anything that
// is not one of the four combat beats.
export function combatEventFrom(type, a, b, c, d, frame, avatarId = null) {
  if (!Object.prototype.hasOwnProperty.call(COMBAT_KIND, type)) return null;
  const kind = COMBAT_KIND[type];
  const avatar = intOrNull(avatarId);
  const isAvatar = (id) => {
    const n = intOrNull(id);
    return avatar !== null && n !== null && n === avatar;
  };
  const frameN = intOrNull(frame);
  if (type === ENGINE_EVENT.HIT) {
    return { kind, actor: intOrNull(a), target: intOrNull(b), damage: intOrNull(c), hp: null, maxHp: null, byPlayer: isAvatar(a) ? true : null, frame: frameN, type };
  }
  if (type === ENGINE_EVENT.BLOCK) {
    return { kind, actor: intOrNull(b), target: intOrNull(a), damage: intOrNull(c), hp: null, maxHp: null, byPlayer: isAvatar(b) ? true : null, frame: frameN, type };
  }
  if (type === ENGINE_EVENT.HURT) {
    return { kind, actor: intOrNull(b), target: intOrNull(a), damage: intOrNull(c), hp: intOrNull(d), maxHp: null, byPlayer: isAvatar(a) ? true : null, frame: frameN, type };
  }
  // DEATH
  const hpAfter = intOrNull(d);
  return { kind, actor: intOrNull(b), target: intOrNull(a), damage: intOrNull(c), hp: hpAfter === null ? 0 : hpAfter, maxHp: null, byPlayer: isAvatar(a) ? true : null, frame: frameN, type };
}

// Engine-page client point -> engine LOGICAL frame coordinates through the
// element's own rect and an aspect-fit (letterbox) projection of the logical
// frame inside the canvas element. This is the coordinate space the contract's
// gesture() call speaks; the logical dimensions MUST come from the engine
// (v1.2 viewport fields) — this helper never invents them, returning null when
// they are unknown so callers can decline instead of guessing the world centre.
export function clientToLogical(geom, clientX, clientY) {
  const iframeRect = geom?.iframeRect ?? { left: 0, top: 0 };
  const cr = geom?.canvasRect ?? { left: 0, top: 0, width: 1, height: 1 };
  const lw = Number(geom?.logicalW) || 0;
  const lh = Number(geom?.logicalH) || 0;
  if (!(lw > 0) || !(lh > 0)) return null;
  const w = Number(cr.width) || 1;
  const h = Number(cr.height) || 1;
  const px = (Number(clientX) - (Number(iframeRect.left) || 0)) - (Number(cr.left) || 0);
  const py = (Number(clientY) - (Number(iframeRect.top) || 0)) - (Number(cr.top) || 0);
  const clamp = (v, max) => (v < 0 ? 0 : v > max ? max : v);

  // Preferred path (v1.2): the engine's OWN letterbox rect, the exact one the
  // backend scales the logical surface through (WINDOW_* == canvas backing
  // store, GAME_DRAW_* == the drawn rect inside it). Used only when the engine
  // flags it valid, so we never guess the mapping from pixel aspect alone.
  const winW = Number(geom?.windowW) || 0;
  const winH = Number(geom?.windowH) || 0;
  const gx = Number(geom?.gameDrawX);
  const gy = Number(geom?.gameDrawY);
  const gw = Number(geom?.gameDrawW) || 0;
  const gh = Number(geom?.gameDrawH) || 0;
  if (geom?.viewportOk === 1 && winW > 0 && winH > 0 && gw > 0 && gh > 0 && Number.isFinite(gx) && Number.isFinite(gy)) {
    const cx = px * winW / w;
    const cy = py * winH / h;
    const x = Math.round((cx - gx) * lw / gw);
    const y = Math.round((cy - gy) * lh / gh);
    return { x: clamp(x, lw - 1), y: clamp(y, lh - 1), scale: gw / lw, logicalW: lw, logicalH: lh, source: "draw-rect" };
  }

  // Fallback: aspect-fit (letterbox) the logical frame centred in the element.
  const scale = Math.min(w / lw, h / lh);
  const drawnW = lw * scale;
  const drawnH = lh * scale;
  const offX = (w - drawnW) / 2;
  const offY = (h - drawnH) / 2;
  const x = Math.round((px - offX) / scale);
  const y = Math.round((py - offY) / scale);
  return { x: clamp(x, lw - 1), y: clamp(y, lh - 1), scale, logicalW: lw, logicalH: lh, source: "aspect-fit" };
}

// ---------------------------------------------------------------------------
// Resolution honesty per abstract action, so callers never mistake a fallback
// for a faithful binding:
//   exact / approximate / gesture / command / unmapped
// ---------------------------------------------------------------------------
export const RESOLUTION = Object.freeze({
  MOVE_NORTH: "exact", MOVE_SOUTH: "exact", MOVE_EAST: "exact", MOVE_WEST: "exact",
  MOVE_NORTH_EAST: "exact", MOVE_NORTH_WEST: "exact",
  MOVE_SOUTH_EAST: "exact", MOVE_SOUTH_WEST: "exact",
  RUN: "exact", JUMP: "exact", CLIMB: "approximate",
  ATTACK: "gesture", KICK: "gesture", BLOCK: "gesture",
  USE: "gesture", PICK_UP: "gesture",
  INVENTORY: "exact", COMBAT_TOGGLE: "exact",
  QUICK_SAVE: "exact", QUICK_LOAD: "approximate",
  MENU: "exact", PAUSE: "command",
});

// Abstract 8-way movement -> contract keybinding action ids. The engine ORs the
// movement flags and derives the direction, so a diagonal is two held flags.
const DIR_ACTIONS = Object.freeze({
  [ACTIONS.MOVE_NORTH]: [ACTION.MOVE_UP],
  [ACTIONS.MOVE_SOUTH]: [ACTION.MOVE_DOWN],
  [ACTIONS.MOVE_WEST]: [ACTION.MOVE_LEFT],
  [ACTIONS.MOVE_EAST]: [ACTION.MOVE_RIGHT],
  [ACTIONS.MOVE_NORTH_EAST]: [ACTION.MOVE_UP, ACTION.MOVE_RIGHT],
  [ACTIONS.MOVE_NORTH_WEST]: [ACTION.MOVE_UP, ACTION.MOVE_LEFT],
  [ACTIONS.MOVE_SOUTH_EAST]: [ACTION.MOVE_DOWN, ACTION.MOVE_RIGHT],
  [ACTIONS.MOVE_SOUTH_WEST]: [ACTION.MOVE_DOWN, ACTION.MOVE_LEFT],
});

// Single contract keybinding action per abstract action.
const SINGLE_ACTIONS = Object.freeze({
  [ACTIONS.RUN]: ACTION.MOVE_RUN,
  [ACTIONS.JUMP]: ACTION.JUMP,
  [ACTIONS.CLIMB]: ACTION.JUMP,          // U8 has no dedicated climb action
  [ACTIONS.INVENTORY]: ACTION.INVENTORY,
  [ACTIONS.COMBAT_TOGGLE]: ACTION.COMBAT,
  [ACTIONS.QUICK_SAVE]: ACTION.QUICKSAVE,
  [ACTIONS.QUICK_LOAD]: ACTION.LOAD,     // no quickload: LOAD opens the dialog
  [ACTIONS.MENU]: ACTION.MENU,
});

// Abstract pointer actions -> contract gesture ids.
const GESTURE_ACTIONS = Object.freeze({
  [ACTIONS.ATTACK]: GESTURE.ATTACK_DOUBLECLICK_LEFT,
  [ACTIONS.KICK]: GESTURE.KICK_DOUBLECLICK_RIGHT,
  [ACTIONS.BLOCK]: GESTURE.BLOCK_HOLD,
  [ACTIONS.USE]: GESTURE.USE_DOUBLECLICK_LEFT,
  [ACTIONS.PICK_UP]: GESTURE.PICK_UP_DRAG_LEFT,
});

const HELD_GESTURES = Object.freeze(new Set([GESTURE.BLOCK_HOLD, GESTURE.PICK_UP_DRAG_LEFT]));

// The ONE engine-page URL. Default is the single config constant; an `?engine=`
// query parameter overrides it (already decoded by URLSearchParams).
export function resolveEngineUrl(win) {
  const search = win?.location?.search;
  if (search) {
    try {
      const override = new URLSearchParams(search).get("engine");
      if (override) return override;
    } catch { /* malformed query: fall back to the constant */ }
  }
  return ENGINE_IFRAME_URL;
}

// Product default is ALWAYS the real bridge. A development-only recording mock
// is reachable only behind an explicit flag, so the Node suites and the host
// UI-wiring harness can observe commands without claiming playability:
//   ?dev  |  ?dev=mock  |  ?bridge=mock  |  window.__U8_DEV_MOCK__ === true
//   |  localStorage["ultima8.dev.mock"] === "1"
export function resolveBridgeMode(win, _doc, storage) {
  const search = win?.location?.search;
  if (search) {
    try {
      const q = new URLSearchParams(search);
      if (q.has("dev") || q.get("dev") === "mock" || q.get("bridge") === "mock") return "mock";
    } catch { /* malformed query: stay real */ }
  }
  if (win?.__U8_DEV_MOCK__ === true) return "mock";
  const store = storage ?? safeStorage(win);
  try { if (store?.getItem?.("ultima8.dev.mock") === "1") return "mock"; } catch { /* stay real */ }
  return "real";
}

function safeStorage(win) {
  try { return win?.localStorage ?? null; } catch { return null; }
}

// Pure coordinate conversion from a parent-page client point to the engine
// canvas's internal pixel space, honouring the iframe offset, the canvas
// element's own rect and letterbox scaling between element size and internal
// resolution. `geom` = { iframeRect, canvasRect, canvasWidth, canvasHeight }.
export function clientToCanvas(geom, clientX, clientY) {
  const iframeRect = geom?.iframeRect ?? { left: 0, top: 0 };
  const canvasRect = geom?.canvasRect ?? { left: 0, top: 0, width: 1, height: 1 };
  const cw = Number(geom?.canvasWidth) || 0;
  const ch = Number(geom?.canvasHeight) || 0;
  const w = Number(canvasRect.width) || 1;
  const h = Number(canvasRect.height) || 1;
  const inFrameX = Number(clientX) - (Number(iframeRect.left) || 0);
  const inFrameY = Number(clientY) - (Number(iframeRect.top) || 0);
  const px = inFrameX - (Number(canvasRect.left) || 0);
  const py = inFrameY - (Number(canvasRect.top) || 0);
  const x = cw ? Math.max(0, Math.min(cw, Math.round((px / w) * cw))) : Math.round(px);
  const y = ch ? Math.max(0, Math.min(ch, Math.round((py / h) * ch))) : Math.round(py);
  return { x, y };
}

// Pure planner: one abstract action -> the contract calls it resolves to.
// Each call is { call: "engineAction"|"gesture"|"pause", ... }. No engine call
// happens here, so this is unit-testable without a browser.
export function planAction(action, ctx = {}) {
  const down = ctx.down !== undefined ? Boolean(ctx.down) : true;
  const point = pointOf(ctx);
  if (Object.prototype.hasOwnProperty.call(DIR_ACTIONS, action)) {
    return DIR_ACTIONS[action].map((id) => ({ call: "engineAction", action: id, down }));
  }
  if (Object.prototype.hasOwnProperty.call(SINGLE_ACTIONS, action)) {
    return [{ call: "engineAction", action: SINGLE_ACTIONS[action], down }];
  }
  if (Object.prototype.hasOwnProperty.call(GESTURE_ACTIONS, action)) {
    const kind = GESTURE_ACTIONS[action];
    if (HELD_GESTURES.has(kind)) {
      return [{ call: "gesture", kind, x: point?.x ?? null, y: point?.y ?? null, hold: down }];
    }
    // Instant gestures (double-click / drag) fire once, on press.
    return down ? [{ call: "gesture", kind, x: point?.x ?? null, y: point?.y ?? null, hold: true }] : [];
  }
  if (action === ACTIONS.PAUSE) {
    return down ? [{ call: "pause", value: true }] : [];
  }
  return [];
}

export function planActions(actions, ctx = {}) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  for (const action of actions) out.push(...planAction(action, ctx));
  return out;
}

function pointOf(ctx) {
  if (ctx.target && Number.isFinite(ctx.target.x) && Number.isFinite(ctx.target.y)) {
    return { x: ctx.target.x | 0, y: ctx.target.y | 0 };
  }
  if (Number.isFinite(ctx.x) && Number.isFinite(ctx.y)) {
    return { x: ctx.x | 0, y: ctx.y | 0 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Raw physical key -> engine key event. The contract states push_event packs
// key events as (a=keycode, b=ascii, c=flags); the engine's own keymapper then
// receives them exactly as if the physical key had been pressed. This is the
// Classic / pre-world path: it never goes through the abstract action map.
//
// `a` is a Common::KeyCode, NOT an SDL2 keycode: bridge_push_event()
// (ultima8_bridge.cpp) does `ev.kbd.keycode = (Common::KeyCode)a;
// ev.kbd.ascii = (uint16)b`. The numbers below are read straight from the
// engine's common/keyboard.h (KEYCODE_RETURN=13, a-z=97..122, KEYCODE_UP=273,
// KEYCODE_F1=282, ...). Anything unlisted is still forwarded with keycode 0 so
// nothing is silently dropped.
const COMMON_KEYCODES = Object.freeze({
  Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, Return: 13, Escape: 27, Space: 32,
  ArrowUp: 273, ArrowDown: 274, ArrowLeft: 276, ArrowRight: 275,
  F1: 282, F2: 283, F3: 284, F4: 285, F5: 286, F6: 287,
  F7: 288, F8: 289, F9: 290, F10: 291, F11: 292, F12: 293,
});

// Returns { keycode, ascii } for a KeyboardEvent.code (and, for text, its key).
// `keycode` is the Common::KeyCode the engine's keymapper matches (letters are
// the lower-case 97..122 block); `ascii` is the character the event actually
// produced, so it PRESERVES ev.key's case (Shift+A -> keycode 97, ascii 65).
export function rawKeyPack(code, key = "") {
  const typed = typeof key === "string" && key.length === 1 ? key.charCodeAt(0) : 0;
  if (Object.prototype.hasOwnProperty.call(COMMON_KEYCODES, code)) {
    const keycode = COMMON_KEYCODES[code];
    const ascii = typed || (keycode > 0 && keycode < 128 ? keycode : 0);
    return { keycode, ascii };
  }
  if (/^Key[A-Z]$/.test(code)) {
    const keycode = code.charCodeAt(3) + 32;   // Common::KEYCODE_a == 97
    return { keycode, ascii: typed || keycode };
  }
  if (/^Digit[0-9]$/.test(code)) {
    const keycode = code.charCodeAt(5);
    return { keycode, ascii: typed || keycode };
  }
  if (/^Numpad[0-9]$/.test(code)) {
    const keycode = 256 + (code.charCodeAt(6) - 48);  // Common::KEYCODE_KP0 == 256
    return { keycode, ascii: typed || 0 };
  }
  // Code-less input/composition (phone keyboards): the produced character is
  // the only signal, so it IS the keycode/ascii pair the prompt must receive.
  if (typed) return { keycode: typed, ascii: typed };
  return { keycode: 0, ascii: 0 };
}

// The development mock. It records the abstract actions the shell dispatches so
// the Node suites and the UI-wiring harness can observe them, but it performs
// NO engine call and never claims playability. It is reachable only behind the
// explicit dev flags in resolveBridgeMode. Persistence/transport methods are
// INTENTIONALLY absent so callers see "needs the game engine" instead of a fake
// success.
// ---------------------------------------------------------------------------
function createMockShellBridge(options = {}) {
  const records = [];
  const heldActions = new Set();
  const noop = () => {};
  const unsub = () => noop;
  const mockUrl = options.engineUrl ?? resolveEngineUrl(options.win ?? null);

  function record(entry) { records.push(entry); return entry; }
  function dispatch(action, ctx = {}) {
    const down = ctx.down !== undefined ? Boolean(ctx.down) : true;
    if (!action) return [];
    record({ action, down, declined: "dev-mock" });
    if (down) heldActions.add(action); else heldActions.delete(action);
    return [{ call: "mock", action, down }];
  }
  function releaseAll() {
    const pending = [...heldActions];
    heldActions.clear();
    for (const a of pending) dispatch(a, { down: false });
    return pending;
  }
  function rawKey(code, down = true, key = "") {
    return record({ raw: true, event: { key: code || key, down: Boolean(down) }, declined: "dev-mock" });
  }

  return {
    mode: "mock",
    contract: CONTRACT_NAME,
    engineUrl: mockUrl,
    element: null,
    phase: PHASE.ENGINE,
    error: null,
    isWorld: () => false,
    isEngine: () => false,
    connect: () => Promise.resolve({ ok: true, phase: PHASE.ENGINE, element: null, error: null }),
    onPhase: () => unsub(),
    onCombat: () => unsub(),
    onError: () => unsub(),
    onEngineEvent: () => unsub(),
    dispatch,
    planAction,
    releaseAll,
    rawKey,
    held: () => [...heldActions],
    records: () => records.map((r) => ({ ...r })),
    actionNames: () => records.map((r) => r.action).filter(Boolean),
    clear: () => { records.length = 0; },
    snapshot: () => null,
    // [W3 click-move] The dev mock performs no engine call; the IDs resolve to
    // the shared constant and walkTo/cancelWalk are recorded no-ops, so the
    // click path can be exercised without pretending the engine accepted it.
    pathActionIds: () => ({ ...PATH_ACTION_IDS }),
    walkTo: (x, y) => record({ call: "walkTo", x, y, declined: "dev-mock" }) && 0,
    cancelWalk: () => record({ call: "cancelWalk", declined: "dev-mock" }) && 0,
    name: () => "Avatar",
    setMode: () => MODE.modern,
    setSpeed: () => ({ requested: null, rate: null, multiplier: null }),
    whenReady: () => Promise.resolve(null),
    confirmState: () => null,
    resumeAudio: () => false,
    audio: () => null,
    focusCanvas: () => false,
    toCanvasPoint: () => null,
    toLogicalPoint: () => null,
    avatarLogicalPoint: () => null,
    targetLogicalPoint: () => null,
    engineViewport: () => null,
    textPromptActive: () => null,
    engineName: () => null,
    destroy: noop,
  };
}

// ---------------------------------------------------------------------------
// The bridge. Real product path only: it reaches the engine's own facade.
// ---------------------------------------------------------------------------
export function createShellBridge(options = {}) {
  if (options.mode === "mock") return createMockShellBridge(options);
  const win = options.win ?? (typeof window !== "undefined" ? window : null);
  const doc = options.doc ?? win?.document ?? null;
  // The default engine URL (no `--save-slot`). `restart` may temporarily point
  // `engineUrl` at a resume URL, but a later restart without one MUST return to
  // this default so a stale slot is never silently reloaded (a new game).
  const baseEngineUrl = options.engineUrl ?? resolveEngineUrl(win);
  let engineUrl = baseEngineUrl;
  let bootSerial = 0;            // monotonic identity for each fresh iframe
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const injectedFacade = options.facade ?? null;
  const resultTimeoutMs = options.resultTimeoutMs ?? DEFAULT_RESULT_TIMEOUT_MS;

  let element = null;
  let phase = options.phase ?? (injectedFacade ? PHASE.ENGINE : PHASE.LOADING);
  let errorMessage = null;
  let stopped = false;
  let timer = null;
  let startedAt = 0;
  let subscribed = false;
  const held = new Set();
  const records = [];
  const phaseListeners = new Set();
  const combatListeners = new Set();
  const errorListeners = new Set();
  const engineEventListeners = new Set();
  // slot -> waiter for a specific SAVE_RESULT/LOAD_RESULT; registered BEFORE
  // the enqueue so an engine that answers on the very next drain is never
  // missed (the old handler-after-enqueue race dropped the completion).
  const resultWaiters = new Map([
    [ENGINE_EVENT.SAVE_RESULT, new Map()],
    [ENGINE_EVENT.LOAD_RESULT, new Map()],
  ]);

  function settleResult(type, slot, ok) {
    const map = resultWaiters.get(type);
    const waiter = map?.get(Number(slot));
    if (!waiter) return false;
    map.delete(Number(slot));
    waiter.settle(Number(ok));
    return true;
  }

  // A restart destroys the engine that would have answered an in-flight
  // SAVE_RESULT/LOAD_RESULT. Settle those waiters with a real error so a caller
  // awaiting them gets a truthful failure instead of a promise that never
  // resolves.
  function abortPendingResults(reason) {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    for (const map of resultWaiters.values()) {
      for (const [key, waiter] of [...map]) {
        map.delete(key);
        try { waiter.fail(err); } catch { /* ignore */ }
      }
    }
  }

  function contentWindow() {
    try { return element?.contentWindow ?? null; } catch { return null; }
  }
  function facade() {
    if (injectedFacade) return injectedFacade;
    const cw = contentWindow();
    if (cw && cw.Ultima8Bridge) return cw.Ultima8Bridge;
    if (win && win.Ultima8Bridge) return win.Ultima8Bridge;
    return null;
  }
  function moduleGlobal() {
    const cw = contentWindow();
    if (cw && cw.Module) return cw.Module;
    if (win && win.Module) return win.Module;
    return null;
  }
  function engineLive() {
    const M = moduleGlobal();
    return Boolean(M && typeof M._bridge_ready === "function");
  }

  // The engine's own controlled/avatar actor id (STATE.CONTROLLED), used only
  // to label an event as player-caused. 0 (or an unreadable state) means the
  // shell declines to guess and leaves byPlayer null.
  function controlledId() {
    const f = facade();
    if (!f) return null;
    try {
      const v = typeof f.readState === "function" ? f.readState(STATE.CONTROLLED) : (f.snapshot?.()?.CONTROLLED);
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch { return null; }
  }

  function setPhase(next) {
    if (phase === next) return;
    phase = next;
    for (const cb of [...phaseListeners]) { try { cb(phase); } catch { /* a listener must not break the pump */ } }
  }
  function setError(message) {
    errorMessage = message;
    setPhase(PHASE.ERROR);
    for (const cb of [...errorListeners]) { try { cb(message); } catch { /* ignore */ } }
  }

  function attachFacade(f) {
    if (subscribed || typeof f?.on !== "function") return;
    subscribed = true;
    try {
      // The E2 hook is Module.bridgeOnEngineEvent(type,a,b,c,d,frame); the
      // facade forwards all six. E1 consumers written as (type,a,b,c) keep
      // working, so we accept the additive d/frame and never require them.
      f.on(null, (type, a, b, c, d, frame) => {
        for (const cb of [...engineEventListeners]) {
          try { cb({ type, a, b, c, d, frame }); } catch { /* ignore */ }
        }
        // Completion events first: an awaiting save()/load() must resolve even
        // if a combat listener throws.
        if (RESULT_TYPES.has(type)) settleResult(type, a, b);
        const event = combatEventFrom(type, a, b, c, d, frame, controlledId());
        if (!event) return;
        for (const cb of [...combatListeners]) { try { cb({ type: "combat", event }); } catch { /* ignore */ } }
      });
    } catch { /* the facade without on() is still usable for commands */ }
  }

  function readReadyState(f) {
    try {
      if (typeof f?.readState === "function") return f.readState(STATE.READY) | 0;
      if (typeof f?.snapshot === "function") return f.snapshot()?.READY | 0;
    } catch { /* treat an unreadable state as not-ready */ }
    return 0;
  }

  function pump() {
    if (stopped) return;
    const f = facade();
    if (f && engineLive()) {
      attachFacade(f);
      if (phase === PHASE.LOADING) setPhase(PHASE.ENGINE);
      if (readReadyState(f) === 1) { setPhase(PHASE.WORLD); return; }
      schedule();
      return;
    }
    if (Date.now() - startedAt >= connectTimeoutMs) {
      setError(`No engine bridge appeared at ${engineUrl} within ${Math.round(connectTimeoutMs / 1000)}s.`);
      return;
    }
    schedule();
  }
  function schedule() {
    if (stopped) return;
    timer = setTimeout(pump, pollMs);
  }

  function ensureElement() {
    if (element || injectedFacade) return element;
    if (typeof doc?.createElement !== "function") return null;
    const frame = doc.createElement("iframe");
    frame.id = "u8-engine-frame";
    frame.className = "engine-frame";
    frame.setAttribute("data-test", "engine");
    // A fresh, monotonic identity so a host probe can tell a NEW boot from a
    // still-mounted old one (a stale READY iframe must never count as restart).
    bootSerial += 1;
    frame.setAttribute("data-boot", String(bootSerial));
    frame.setAttribute("title", "Ultima VIII: Pagan");
    frame.setAttribute("allow", "autoplay; fullscreen; gamepad");
    frame.src = engineUrl;
    element = frame;
    return frame;
  }

  // Mount the engine surface and start the readiness pump. Resolves once the
  // facade + live Module are seen (phase "engine"). It MUST NOT await whenReady
  // before mounting or nothing would ever boot.
  function connect() {
    const frame = ensureElement();
    startedAt = Date.now();
    if (injectedFacade) {
      attachFacade(injectedFacade);
      if (readReadyState(injectedFacade) === 1) setPhase(PHASE.WORLD);
      return Promise.resolve({ ok: true, phase, element, error: errorMessage });
    }
    if (phase === PHASE.LOADING) schedule();
    return new Promise((resolve) => {
      const done = (err) => resolve({ ok: !err, phase, element, error: err ?? null });
      if (phase === PHASE.ENGINE || phase === PHASE.WORLD) return done(null);
      if (phase === PHASE.ERROR) return done(errorMessage);
      const stop = onPhase((p) => {
        if (p === PHASE.ENGINE || p === PHASE.WORLD) { stop(); done(null); }
        else if (p === PHASE.ERROR) { stop(); done(errorMessage || "engine failed to load"); }
      });
    });
  }

  function record(entry) { records.push(entry); return entry; }
  function onPhase(cb) { phaseListeners.add(cb); return () => phaseListeners.delete(cb); }
  function onCombat(cb) { combatListeners.add(cb); return () => combatListeners.delete(cb); }
  function onError(cb) { errorListeners.add(cb); return () => errorListeners.delete(cb); }
  // Raw additive v1.1 engine-event stream. No UI consumer yet; exposed so a
  // save/load completion or attack start/end can be wired without a rewrite.
  function onEngineEvent(cb) { engineEventListeners.add(cb); return () => engineEventListeners.delete(cb); }

  function canvasEl() {
    const f = facade();
    try { if (typeof f?.canvas === "function") { const c = f.canvas(); if (c) return c; } } catch { /* fall through */ }
    try { return contentWindow()?.document?.getElementById?.("canvas") ?? null; } catch { return null; }
  }

  // The engine's logical frame size, feature-detected from the snapshot's
  // additive v1.2 viewport fields. Returns null (never a guess) when the engine
  // has not published them, so a gesture declines instead of aiming at an
  // invented world centre in the wrong (canvas-pixel) space.
  function engineViewport() {
    const snap = snapshot();
    const lw = pickNumber(snap, ["LOGICAL_W", "LOGICAL_WIDTH", "GAME_W", "VIEW_LOGICAL_W", "SCREEN_W"]);
    const lh = pickNumber(snap, ["LOGICAL_H", "LOGICAL_HEIGHT", "GAME_H", "VIEW_LOGICAL_H", "SCREEN_H"]);
    if (lw === null || lh === null || !(lw > 0) || !(lh > 0)) return null;
    // v1.2 letterbox rect, only trusted when the engine flags VIEWPORT_OK==1.
    const viewportOk = pickNumber(snap, ["VIEWPORT_OK"]);
    const winW = pickNumber(snap, ["WINDOW_W"]);
    const winH = pickNumber(snap, ["WINDOW_H"]);
    const gameDrawX = pickNumber(snap, ["GAME_DRAW_X"]);
    const gameDrawY = pickNumber(snap, ["GAME_DRAW_Y"]);
    const gameDrawW = pickNumber(snap, ["GAME_DRAW_W"]);
    const gameDrawH = pickNumber(snap, ["GAME_DRAW_H"]);
    return { logicalW: lw, logicalH: lh, viewportOk, winW, winH, gameDrawX, gameDrawY, gameDrawW, gameDrawH };
  }

  // The avatar's engine-logical screen point from the snapshot, when published.
  function avatarLogicalPoint() {
    const snap = snapshot();
    if (!snap) return null;
    // AVATAR_SCREEN_OK is the engine's own validity flag: honour it when the
    // build publishes it (invalid => decline), else accept the coords if both
    // are present (older builds that lacked the flag).
    const ok = pickNumber(snap, ["AVATAR_SCREEN_OK"]);
    if (ok !== null && ok !== 1) return null;
    const x = pickNumber(snap, ["AVATAR_SCREEN_X", "AVATAR_LOGICAL_X", "AVATAR_X", "AVATAR_CLICK_X"]);
    const y = pickNumber(snap, ["AVATAR_SCREEN_Y", "AVATAR_LOGICAL_Y", "AVATAR_Y", "AVATAR_CLICK_Y"]);
    if (x === null || y === null) return null;
    return { x, y };
  }

  // The nearest hostile target's engine-logical screen point, only when the
  // engine flags it valid (the contract's alignment predicate decided it).
  function targetLogicalPoint() {
    const snap = snapshot();
    if (!snap || Number(snap.TARGET_SCREEN_OK) !== 1) return null;
    const x = pickNumber(snap, ["TARGET_SCREEN_X"]);
    const y = pickNumber(snap, ["TARGET_SCREEN_Y"]);
    if (x === null || y === null) return null;
    return { x, y };
  }

  // Is the engine's OWN text prompt live right now? The shell must show its
  // HTML name proxy only at that moment, not over the original intro. This flag
  // is additive and not in the frozen v1 contract, so it is feature-detected:
  // returns true/false when the engine publishes it, or null when the build has
  // no such signal (the caller then declines to claim either way).
  function textPromptActive() {
    const f = facade();
    try { if (typeof f?.textInputActive === "function") return Boolean(f.textInputActive()); } catch { /* fall through */ }
    const v = pickNumber(snapshot(), ["TEXT_INPUT_ACTIVE", "TEXTINPUT_ACTIVE", "TEXT_INPUT", "NAME_PROMPT_ACTIVE"]);
    if (v === null) return null;
    return v === 1;
  }

  // Resolve a gesture point in engine-logical space: an explicitly supplied
  // point wins, otherwise the avatar's own logical point. Never the canvas
  // centre (that was the 900-px guess this replaces).
  function resolvePoint(ctx) {
    const p = pointOf(ctx);
    if (p) return p;
    return avatarLogicalPoint();
  }

  function executeCall(f, call, ctx) {
    if (call.call === "engineAction") {
      if (typeof f.engineAction !== "function") return null;
      f.engineAction(call.action, call.down ? 1 : 0);
      return { call: "engineAction", action: call.action, down: call.down };
    }
    if (call.call === "gesture") {
      if (typeof f.gesture !== "function") return null;
      const p = (call.x == null || call.y == null) ? resolvePoint(ctx) : { x: call.x, y: call.y };
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        // No engine-logical point yet (the v1.2 viewport/avatar fields are not
        // published). Decline visibly rather than aim at a guessed centre.
        return { call: "gesture", kind: call.kind, x: null, y: null, hold: call.hold, declined: "no-viewport" };
      }
      f.gesture(call.kind, p.x, p.y, call.hold ? 1 : 0);
      return { call: "gesture", kind: call.kind, x: p.x, y: p.y, hold: call.hold };
    }
    if (call.call === "pause") {
      if (typeof f.pause !== "function") return null;
      f.pause(call.value ? 1 : 0);
      return { call: "pause", value: call.value };
    }
    return null;
  }

  // Translate and send one abstract action. Only valid in `world`; elsewhere it
  // is recorded as declined so the reason is visible, never silently dropped.
  function dispatch(action, ctx = {}) {
    const down = ctx.down !== undefined ? Boolean(ctx.down) : true;
    const plan = planAction(action, ctx);
    if (plan.length === 0) { record({ action, down, declined: "unmapped" }); return []; }
    if (phase !== PHASE.WORLD) { record({ action, down, declined: `phase:${phase}` }); return []; }
    const f = facade();
    if (!f) { record({ action, down, declined: "no-engine" }); return []; }
    const executed = [];
    for (const call of plan) {
      const done = executeCall(f, call, ctx);
      executed.push(done);
      record({ action, down, call: done });
    }
    if (down) held.add(action); else held.delete(action);
    return executed;
  }

  function releaseAll() {
    const pending = [...held];
    held.clear();
    for (const action of pending) dispatch(action, { down: false });
    return pending;
  }

  // Wait for the engine's own SAVE_RESULT/LOAD_RESULT for `slot`. Registered
  // before the caller enqueues; rejects (visible) on timeout rather than hanging.
  function awaitEngineResult(type, slot, timeoutMs = DEFAULT_RESULT_TIMEOUT_MS) {
    const map = resultWaiters.get(type);
    const key = Number(slot);
    return new Promise((resolve, reject) => {
      const setT = win?.setTimeout ?? (typeof setTimeout !== "undefined" ? setTimeout : null);
      const clearT = win?.clearTimeout ?? (typeof clearTimeout !== "undefined" ? clearTimeout : null);
      if (map.has(key)) map.delete(key); // a stale waiter for this slot loses
      let timer = null;
      if (!setT) { resolve(null); return; }
      const clear = () => { if (timer && clearT) clearT(timer); map.delete(key); };
      timer = setT(() => {
        map.delete(key);
        reject(new Error(type === ENGINE_EVENT.SAVE_RESULT
          ? "the engine did not confirm the save in time"
          : "the engine did not confirm the load in time"));
      }, timeoutMs);
      map.set(key, { settle: (ok) => { clear(); resolve(ok); }, fail: (err) => { clear(); reject(err); } });
    });
  }

  async function confirmState(field, want, timeoutMs = confirmTimeoutMs) {
    const f = facade();
    if (!f || typeof f.readState !== "function") return null;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = f.readState(field);
      if (want === undefined || value === want) return value;
      if (Date.now() >= deadline) return value;
      await delay(pollMs, win);
    }
  }

  async function whenReady() {
    const f = facade();
    if (!f) throw new Error("engine not connected");
    if (phase === PHASE.WORLD) return f;
    if (typeof f.whenReady === "function") {
      await f.whenReady();
      setPhase(PHASE.WORLD);
      return f;
    }
    await confirmState(STATE.READY, 1, connectTimeoutMs);
    return f;
  }

  function snapshot() {
    const f = facade();
    if (!f) return null;
    if (typeof f.snapshot === "function") return f.snapshot();
    if (typeof f.readState === "function") {
      const out = {};
      for (const k of Object.keys(STATE)) out[k] = f.readState(STATE[k]);
      return out;
    }
    return null;
  }

  function requireFacade() {
    const f = facade();
    if (!f) throw new Error("the game engine is not connected");
    return f;
  }

  function setMode(mode) {
    const f = requireFacade();
    const want = (mode === MODE.classic || mode === "classic" || mode === 1) ? MODE.classic : MODE.modern;
    f.setMode(want);
    // Confirm from the engine's own state; the UI shows what the engine reports,
    // never the value we asked for.
    return confirmState(STATE.MODE, want);
  }

  async function setSpeed(mult) {
    const f = requireFacade();
    const value = Number(mult);
    if (!Number.isFinite(value)) throw new Error("speed must be a number");
    f.setSpeed(value);
    const rate = await confirmState(STATE.SPEED_RATE, undefined, Math.min(confirmTimeoutMs, 800));
    return { requested: value, rate, multiplier: rate > 0 ? Math.round((100 / rate) * 100) / 100 : null };
  }

  // Enqueue a save and WAIT for the engine's own SAVE_RESULT(slot, ok===1),
  // then flush IDBFS. The enqueue return is never treated as success. When the
  // facade has no event stream (older/partial build) the confirmation step is
  // skipped and ok stays null, which the UI reports as "unconfirmed" — never as
  // saved.
  async function save(slot = 1) {
    const f = requireFacade();
    if (typeof f.save !== "function") throw new Error("this engine build has no save");
    const awaiting = typeof f.on === "function" ? awaitEngineResult(ENGINE_EVENT.SAVE_RESULT, slot, resultTimeoutMs) : null;
    const queued = f.save(slot);
    if (!queued) {
      if (awaiting) awaiting.catch(() => {});
      throw new Error("the engine rejected the save request");
    }
    if (typeof f.syncfs === "function") f.syncfs();
    let ok = null;
    if (awaiting) {
      ok = await awaiting;
      if (ok !== 1) throw new Error("the engine reported the save failed");
    }
    let durable = null;
    if (typeof f.flushPersist === "function") {
      try { durable = Boolean(await f.flushPersist()); } catch { durable = false; }
      if (durable === false) throw new Error("the save was not written to storage");
    }
    return { queued: Number(queued), ok, durable };
  }

  // Enqueue a load and WAIT for LOAD_RESULT(slot, ok===1).
  async function load(slot = 1) {
    const f = requireFacade();
    if (typeof f.load !== "function") throw new Error("this engine build has no load");
    const awaiting = typeof f.on === "function" ? awaitEngineResult(ENGINE_EVENT.LOAD_RESULT, slot, resultTimeoutMs) : null;
    const queued = f.load(slot);
    if (!queued) {
      if (awaiting) awaiting.catch(() => {});
      throw new Error("the engine rejected the load request");
    }
    if (awaiting) {
      const ok = await awaiting;
      if (ok !== 1) throw new Error("the engine reported the load failed");
    }
    return true;
  }

  // Export REAL bytes for the CURRENT game: ask the engine to save the live
  // state into `slot` first (completion + flush), then read the freshly written
  // file. Reading an old slot without re-saving is what made exports stale.
  async function exportSave(slot = 1) {
    const f = requireFacade();
    if (typeof f.exportSave !== "function") throw new Error("this engine build cannot export");
    if (typeof f.save === "function") await save(slot);
    const bytes = f.exportSave(slot);
    if (!bytes || !bytes.length) throw new Error("the engine did not return save data");
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  // Write the chosen bytes into `slot`, flush, then load the slot and wait for
  // its LOAD_RESULT. Errors from any stage propagate to the caller.
  async function importSave(slot, bytes) {
    const f = requireFacade();
    if (typeof f.importSave !== "function") throw new Error("this engine build cannot import");
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
    if (!data.length) throw new Error("the save file is empty");
    const awaiting = typeof f.on === "function" ? awaitEngineResult(ENGINE_EVENT.LOAD_RESULT, slot, resultTimeoutMs) : null;
    const written = f.importSave(slot, data);
    if (!written) {
      if (awaiting) awaiting.catch(() => {});
      throw new Error("the engine rejected the save file");
    }
    if (typeof f.syncfs === "function") f.syncfs();
    if (typeof f.flushPersist === "function") {
      try { await f.flushPersist(); } catch { /* flush is best-effort */ }
    }
    if (awaiting) {
      const ok = await awaiting;
      if (ok !== 1) throw new Error("the engine reported the imported save failed to load");
    } else if (typeof f.load === "function") {
      const loaded = f.load(slot);
      if (!loaded) throw new Error("the engine rejected the load request");
    }
    return true;
  }

  function pause(flag) { const f = requireFacade(); return f.pause(flag ? 1 : 0); }
  // Stage a verified General MIDI SoundFont into the engine's own filesystem
  // (the facade's setSoundFont copies the bytes and points ConfMan at them).
  // Returns the engine's own 1/0; never claims success on its behalf.
  function setSoundFont(bytes) {
    const f = requireFacade();
    if (typeof f.setSoundFont !== "function") throw new Error("this engine build cannot load instruments");
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
    return Number(f.setSoundFont(data));
  }
  // Ask the engine to flush its persisted filesystem (IDBFS) after a staged
  // font or a SET_OPTION, so a subsequent restart reads the durable copy.
  async function flushPersist() {
    const f = requireFacade();
    if (typeof f.flushPersist !== "function") return null;
    try { return Boolean(await f.flushPersist()); } catch { return false; }
  }
  // OPTIONAL engine boot-status interface (an L2 build may publish it): the
  // engine's own honest view of a failed/timed-out start and any FM fallback.
  // Feature-detected on the facade, then on the page global; null when absent.
  function bootStatus() {
    const f = facade();
    try { if (f && typeof f.bootStatus === "function") return f.bootStatus(); } catch { /* ignore */ }
    try { if (win && win.Ultima8BootStatus) return win.Ultima8BootStatus; } catch { /* ignore */ }
    return null;
  }
  // REALLY start over: tear down the mounted engine surface and remount a fresh
  // one (a new iframe / a reloaded facade), resetting readiness so the shell
  // re-applies prefs on the next WORLD. Never fakes a live switch.
  function restart(opts = {}) {
    // A resume restart points at the save-slot URL; ANY other restart returns to
    // the plain default so the engine never boots into a stale slot (new game).
    engineUrl = opts.engineUrl ?? baseEngineUrl;
    if (timer) { clearTimeout(timer); timer = null; }
    if (element && element.parentNode) { try { element.parentNode.removeChild(element); } catch { /* ignore */ } }
    element = null;
    stopped = false;
    subscribed = false;
    errorMessage = null;
    abortPendingResults(new Error("the engine restarted before the result arrived"));
    startedAt = Date.now();
    phase = injectedFacade ? PHASE.ENGINE : PHASE.LOADING;
    return connect();
  }
  function setOption(id, value) { const f = requireFacade(); return f.setOption(id, value); }
  function resetInbox() { const f = requireFacade(); return f.resetInbox(); }
  function engineAction(action, down) { const f = requireFacade(); return f.engineAction(action, down ? 1 : 0); }
  // [W3 click-move] The single source of the producer's numeric path-action
  // IDs. Prefers the engine's own published constants when the facade exposes
  // them; otherwise falls back to the shared W3 constant, which is null until
  // W2 publishes its findings (feature stays off). Never a hard-coded guess.
  function pathActionIds() {
    const f = facade();
    let live = null;
    try {
      if (typeof f?.pathActionIds === "function") live = f.pathActionIds();
      else if (f?.pathActionIds && typeof f.pathActionIds === "object") live = f.pathActionIds;
    } catch { live = null; }
    const resolved = resolvePathActionIds(live ? { pathActionIds: live } : null);
    if (resolved.WALK_TO !== null) return resolved;
    return { WALK_TO: PATH_ACTION_IDS.WALK_TO, CANCEL_WALK: PATH_ACTION_IDS.CANCEL_WALK };
  }
  // Start a native walk to an engine-LOGICAL point. Returns the engine's own
  // acceptance (1 accepted, 0 rejected); 0 when the build has no path action.
  function walkTo(logicalX, logicalY) {
    const ids = pathActionIds();
    if (ids.WALK_TO === null || ids.WALK_TO === undefined) return 0;
    const f = facade();
    if (!f || typeof f.engineAction !== "function") return 0;
    try { return Number(f.engineAction(ids.WALK_TO, logicalX | 0, logicalY | 0)) || 0; } catch { return 0; }
  }
  // Cancel a pending walk. Idempotent; safe when no walk action exists.
  function cancelWalk() {
    const ids = pathActionIds();
    if (ids.CANCEL_WALK === null || ids.CANCEL_WALK === undefined) return 0;
    const f = facade();
    if (!f || typeof f.engineAction !== "function") return 0;
    try { return Number(f.engineAction(ids.CANCEL_WALK)) || 0; } catch { return 0; }
  }
  function gesture(kind, x, y, hold) { const f = requireFacade(); return f.gesture(kind, x, y, hold ? 1 : 0); }
  function pushEvent(type, a, b, c, d) { const f = requireFacade(); return f.pushEvent(type, a, b, c, d); }

  // Classic / pre-world physical key -> the engine's own keymapper, verbatim.
  // Uses the contract's push_event packing (a=keycode, b=ascii, c=flags) when
  // the facade is live; before then it only records, so a Classic press is
  // never lost and never faked as an abstract action. Recorded with the same
  // {raw,event:{key,down}} shape the host QA harness reads.
  // `key` is the typed character for text proxies: phone keyboards often emit
  // `input`/composition with no usable key code, so the caller forwards the
  // character itself and the packer turns it into a keycode/ascii pair.
  function rawKey(code, down = true, key = "") {
    const { keycode, ascii } = rawKeyPack(code, key);
    const on = Boolean(down);
    const f = facade();
    let call = null;
    if (f && typeof f.pushEvent === "function") {
      const type = on ? EVENT.KEYDOWN : EVENT.KEYUP;
      f.pushEvent(type, keycode, ascii, 0, 0);
      call = { call: "pushEvent", type, keycode, ascii };
    }
    return record({ raw: true, event: { key: code || key, keycode, ascii, down: on }, call });
  }

  function name() {
    const f = facade();
    try { if (typeof f?.name === "function") return f.name(); } catch { /* ignore */ }
    return "Avatar";
  }

  // The engine's OWN avatar name, or null when the build exposes no name
  // accessor. The HUD must not present the shell's committed draft as the
  // engine's name, so the caller only uses this when it is non-null.
  function engineName() {
    const f = facade();
    try { if (typeof f?.name === "function") { const n = f.name(); return typeof n === "string" && n.trim() ? n.trim() : null; } } catch { /* ignore */ }
    return null;
  }

  // Resume the engine's own SDL audio context on the first real user gesture.
  // There is NO bridge audio-unlock call; this is the engine's actual symbol
  // (Module.SDL3.audioContext, created lazily by the SDL3 library).
  async function resumeAudio() {
    const cw = contentWindow();
    const M = moduleGlobal();
    const ctx = M?.SDL3?.audioContext ?? cw?.SDL3?.audioContext ?? null;
    if (ctx && typeof ctx.resume === "function") {
      if (ctx.state === "suspended") { try { await ctx.resume(); } catch { return false; } }
      // Only an ACTUALLY running context counts as unlocked; a context that is
      // still suspended (or absent) must be retried on a later gesture.
      return ctx.state === "running";
    }
    return false;
  }

  // The engine's own ACHIEVED audio status (the facade's `audio()` accessor):
  // the live synth driver (0 none / 1 FM / 2 GM), whether a SoundFont actually
  // finished loading, the honest fallback/load-error flags, the real SDL3
  // AudioContext state and the live always-run value. This is what the engine
  // reports, never the chosen preference. If the build publishes no audio()
  // accessor, fall back to the same STATE indices (AUDIO_STATE 53..60).
  function audio() {
    const f = facade();
    if (!f) return null;
    if (typeof f.audio === "function") { try { return f.audio(); } catch { return null; } }
    if (typeof f.readState === "function") {
      const rd = (i) => { try { return f.readState(i); } catch { return -1; } };
      return {
        synth: rd(AUDIO_STATE.AUDIO_SYNTH),
        fontLoaded: rd(AUDIO_STATE.AUDIO_FONT_LOADED),
        musicVolume: rd(AUDIO_STATE.AUDIO_MUSIC_VOL),
        sfxVolume: rd(AUDIO_STATE.AUDIO_SFX_VOL),
        loadError: rd(AUDIO_STATE.AUDIO_LOAD_ERROR),
        fallback: rd(AUDIO_STATE.AUDIO_FALLBACK),
        contextState: rd(AUDIO_STATE.AUDIO_CONTEXT_STATE),
        alwaysRun: rd(AUDIO_STATE.ALWAYS_RUN),
      };
    }
    return null;
  }

  function focusCanvas() {
    const c = canvasEl();
    try { c?.focus?.(); return Boolean(c); } catch { return false; }
  }

  // Parent-page client point -> engine canvas internal pixels. This path is
  // kept for native/canvas interactions; game gestures use toLogicalPoint.
  function toCanvasPoint(clientX, clientY) {
    const c = canvasEl();
    if (!c || typeof c.getBoundingClientRect !== "function") return null;
    const iframeRect = element?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const canvasRect = c.getBoundingClientRect();
    return clientToCanvas(
      { iframeRect, canvasRect, canvasWidth: c.width, canvasHeight: c.height },
      clientX, clientY,
    );
  }

  // Parent-page client point -> engine LOGICAL frame coordinates via the
  // letterbox projection. Returns null when the engine has not published its
  // logical size, so the caller can decline instead of mis-aiming.
  function toLogicalPoint(clientX, clientY) {
    const vp = engineViewport();
    const c = canvasEl();
    if (!vp || !c || typeof c.getBoundingClientRect !== "function") return null;
    const iframeRect = element?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    return clientToLogical(
      {
        iframeRect, canvasRect: c.getBoundingClientRect(),
        logicalW: vp.logicalW, logicalH: vp.logicalH,
        viewportOk: vp.viewportOk, windowW: vp.winW, windowH: vp.winH,
        gameDrawX: vp.gameDrawX, gameDrawY: vp.gameDrawY, gameDrawW: vp.gameDrawW, gameDrawH: vp.gameDrawH,
      },
      clientX, clientY,
    );
  }

  // CP61 art-mode bridge wrappers. Delegate to the facade, returning null/false
  // if the method is absent so the UI can show "state unknown".
  function getArtState() {
    const f = facade();
    if (!f || typeof f.getArtState !== "function") return null;
    try { return f.getArtState(); } catch { return null; }
  }

  function setArtMode(mode) {
    const f = facade();
    if (!f || typeof f.setArtMode !== "function") return false;
    try { return Boolean(f.setArtMode(mode)); } catch { return false; }
  }

  function destroy() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  return {
    mode: "real",
    contract: CONTRACT_NAME,
    get engineUrl() { return engineUrl; },
    get element() { return element; },
    get phase() { return phase; },
    get error() { return errorMessage; },
    isWorld: () => phase === PHASE.WORLD,
    isEngine: () => phase === PHASE.ENGINE || phase === PHASE.WORLD,
    connect,
    onPhase,
    onCombat,
    onError,
    onEngineEvent,
    dispatch,
    rawKey,
    planAction,
    releaseAll,
    held: () => [...held],
    records: () => records.map((r) => ({ ...r })),
    actionNames: () => records.map((r) => r.action).filter(Boolean),
    clear: () => { records.length = 0; },
    snapshot,
    name,
    engineName,
    setMode,
    setSpeed,
    save,
    load,
    exportSave,
    importSave,
    pause,
    setOption,
    setSoundFont,
    flushPersist,
    bootStatus,
    restart,
    resetInbox,
    engineAction,
    pathActionIds,
    walkTo,
    cancelWalk,
    gesture,
    pushEvent,
    whenReady,
    confirmState,
    resumeAudio,
    audio,
    focusCanvas,
    toCanvasPoint,
    toLogicalPoint,
    avatarLogicalPoint,
    targetLogicalPoint,
    engineViewport,
    textPromptActive,
    getArtState,
    setArtMode,
    destroy,
  };
}

function delay(ms, win) {
  const setT = win?.setTimeout ?? (typeof setTimeout !== "undefined" ? setTimeout : null);
  if (!setT) return Promise.resolve();
  return new Promise((resolve) => setT(resolve, ms));
}
