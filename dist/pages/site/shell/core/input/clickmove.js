// shell/core/input/clickmove.js
// Click-to-move (mouse) for Modern play. Pure ES module: no DOM, no window,
// no bridge import. The shell feeds it an engine snapshot + viewport and it
// returns decisions; tests exercise every clause of the frozen click_move
// contract without a browser.
//
// CONTRACT SOURCE (authoritative, CP22 complete JSON overrides the earlier
// partial): Modern mode only, mouse pointer on PC, setting "Click to move"
// default ON, forced OFF in Classic; touch tap-to-move default OFF this phase.
// A single left click (press+release < 250 ms, < 6 px travel) inside the
// GAME_DRAW rect with VIEWPORT_OK, mapped through letterboxing to logical
// pixels, and not on shell HUD/controls or a native gump, walks the Avatar via
// the engine's own PathfinderProcess. The shell NEVER synthesises movement keys
// and never teleports.

// --- Legacy engineAction-id constant (retained for the frozen W3 tests) ------
// W2 ultimately published click-to-walk as the facade METHOD PAIR walkTo /
// cancelWalk (command queue ids 9/10, see .scratch/m3-w2-api.json), so these
// engineAction enum ids stay null and are never passed to engineAction().
// Capability is gated on the method pair + PATH_STATE, not on a numeric id.
export const PATH_ACTION_IDS = Object.freeze({
  WALK_TO: null,
  CANCEL_WALK: null,
});

// The W2 command-queue ids the facade methods enqueue internally. Exposed for
// documentation/tests only; the shell never queues them itself.
export const PATH_CMD_IDS = Object.freeze({ WALK_TO: 9, CANCEL_WALK: 10 });

// Engine state slots (complete Fable contract). PATH_STATE/PATH_SEQ are the
// path-capable build's block; GUMP_* is optional.
export const PATH_SLOTS = Object.freeze({
  PATH_STATE: 61,
  PATH_SEQ: 62,
  GUMP_COUNT: 63,
  GUMP_RECT_BASE: 64, // 64..79 = up to 4 rects of x,y,w,h (logical pixels)
  GUMP_RECT_FIELDS: 4,
  GUMP_RECT_MAX: 4,
  // Slots 61 + 62 => a snapshot that reaches index 62, i.e. "length >= 63".
  MIN_PATH_SLOTS: 63,
});

// PATH_STATE semantics. 0 means the slot was never written by a path-capable
// build, so 0 is UNAVAILABLE (feature off), NOT idle.
export const PATH_STATE = Object.freeze({
  UNAVAILABLE: 0,
  IDLE: 1,
  ACTIVE: 2,
  ARRIVED: 3,
  FAILED: 4,
  CANCELLED: 5,
});

// Letterbox viewport slots (v1.2, 42..50). The click mapping reads these
// instead of assuming canvas pixels are game pixels.
export const VIEWPORT_SLOTS = Object.freeze({
  LOGICAL_W: 42,
  LOGICAL_H: 43,
  WINDOW_W: 44,
  WINDOW_H: 45,
  GAME_DRAW_X: 46,
  GAME_DRAW_Y: 47,
  GAME_DRAW_W: 48,
  GAME_DRAW_H: 49,
  VIEWPORT_OK: 50,
  TEXT_INPUT_ACTIVE: 51,
});

export const CLICK_MAX_MS = 250;
export const CLICK_MAX_TRAVEL_PX = 6;
export const DOUBLE_CLICK_MS = 300;

// The shell plays screen id that permits pointer passthrough to the engine.
export const PLAY_SCREEN = "play";

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function boolTrue(v) {
  return v === true || v === 1 || v === "1";
}

// Read a named state field, falling back to its numeric slot for a
// slot-keyed or array snapshot. Returns null when genuinely absent.
export function readSlot(snapshot, names, slot) {
  if (snapshot == null) return null;
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    if (name && snapshot[name] !== undefined) return toNum(snapshot[name]);
  }
  if (slot !== undefined && snapshot[slot] !== undefined) return toNum(snapshot[slot]);
  return null;
}

// Highest readable state index in a snapshot: an array reports its length - 1,
// an object/name-keyed snapshot reports the max numeric key when slot-keyed.
// Used only to honour the contract's "snapshot length is at least 63".
export function snapshotCoverage(snapshot) {
  if (snapshot == null) return 0;
  if (Array.isArray(snapshot)) return snapshot.length;
  if (typeof snapshot !== "object") return 0;
  let max = -1;
  for (const key of Object.keys(snapshot)) {
    const n = Number(key);
    if (Number.isInteger(n) && n >= 0 && n > max) max = n;
  }
  return max + 1;
}

// --- W2 native facade adapter -----------------------------------------------
// W2 publishes click-to-walk as a METHOD PAIR on the live facade:
// `Ultima8Bridge.walkTo(x, y)` / `Ultima8Bridge.cancelWalk()`. They enqueue
// command-queue ids 9/10 internally -- they are NOT engineAction enum ids, so
// the shell must never route 9/10 through engineAction(action, down).
//
// `facade` is any object exposing those two functions (the real one is reached
// as frame.contentWindow.Ultima8Bridge). Returns a bound pair, or null when the
// pair is incomplete -- the single capability gate.
export function facadePathMethods(facade) {
  if (!facade || typeof facade !== "object") return null;
  const walkTo = typeof facade.walkTo === "function" ? facade.walkTo : null;
  const cancelWalk = typeof facade.cancelWalk === "function" ? facade.cancelWalk : null;
  if (!walkTo || !cancelWalk) return null;
  return {
    facade,
    walkTo: (x, y) => walkTo.call(facade, x | 0, y | 0),
    cancelWalk: () => cancelWalk.call(facade),
  };
}

// Resolve `Ultima8Bridge` from a window/frame, tolerating cross-origin throws
// and an engine that has not mounted yet. Never cached across navigations.
export function liveFacade(source) {
  let f = null;
  try { f = source?.Ultima8Bridge ?? null; } catch { f = null; }
  return f && typeof f === "object" ? f : null;
}

// --- Capability detection ---------------------------------------------------
// Enable click-move ONLY when ALL hold: the running snapshot publishes
// PATH_STATE (61) and PATH_SEQ (62), PATH_STATE is 1 or higher on a ready
// frame, and the live facade exposes the walkTo/cancelWalk method pair. PATH_STATE
// 0/missing (the accepted 7ec build) or a missing method pair => unavailable.
export function detectPathCapability(input = {}) {
  const snapshot = input.snapshot ?? null;
  const ready = input.ready;
  if (snapshot == null) return { available: false, reason: "no-snapshot" };
  const state = readSlot(snapshot, "PATH_STATE", PATH_SLOTS.PATH_STATE);
  const seq = readSlot(snapshot, "PATH_SEQ", PATH_SLOTS.PATH_SEQ);
  if (state === null || seq === null) return { available: false, reason: "no-path-slots", state, seq };
  if (ready === false || ready === 0) return { available: false, reason: "not-ready", state, seq };
  if (!(state >= PATH_STATE.IDLE)) return { available: false, reason: "path-state-unavailable", state, seq };
  const pair = input.pair ?? facadePathMethods(input.facade);
  if (!pair) return { available: false, reason: "no-walk-pair", state, seq };
  return { available: true, reason: "ok", state, seq, pair };
}

// Resolve W2's IDs from the bridge adapter, else the single module constant.
export function resolvePathActionIds(bridge) {
  let ids = null;
  try {
    ids = typeof bridge?.pathActionIds === "function" ? bridge.pathActionIds() : (bridge?.pathActionIds ?? null);
  } catch { ids = null; }
  const walk = toNum(ids?.WALK_TO);
  const cancel = toNum(ids?.CANCEL_WALK);
  if (walk === null) return { WALK_TO: PATH_ACTION_IDS.WALK_TO, CANCEL_WALK: PATH_ACTION_IDS.CANCEL_WALK };
  return { WALK_TO: walk, CANCEL_WALK: cancel ?? PATH_ACTION_IDS.CANCEL_WALK };
}

// --- Click classification ---------------------------------------------------
// press/release: { x, y, t } (client px + ms). A click is a left press+release
// under 250 ms and under 6 px of travel.
export function classifyClick(press, release, opts = {}) {
  if (!press || !release) return { kind: "ignore", reason: "missing" };
  const maxMs = opts.maxMs ?? CLICK_MAX_MS;
  const maxTravel = opts.maxTravel ?? CLICK_MAX_TRAVEL_PX;
  const dt = toNum(release.t) !== null && toNum(press.t) !== null ? Number(release.t) - Number(press.t) : NaN;
  const dx = (toNum(release.x) ?? 0) - (toNum(press.x) ?? 0);
  const dy = (toNum(release.y) ?? 0) - (toNum(press.y) ?? 0);
  const travel = Math.hypot(dx, dy);
  if (!(dt >= 0 && dt <= maxMs)) return { kind: "ignore", reason: "duration", dt, travel };
  if (!(travel <= maxTravel)) return { kind: "ignore", reason: "travel", dt, travel };
  return { kind: "click", dt, travel };
}

// --- Letterbox mapping (slots 42..49) ---------------------------------------
// Normalise either the bridge's engineViewport() shape or a slot-named object.
export function normalizeViewport(raw) {
  if (!raw) return null;
  const pick = (names) => {
    for (const n of names) if (raw[n] !== undefined) return toNum(raw[n]);
    return null;
  };
  return {
    ok: pick(["viewportOk", "VIEWPORT_OK", "ok"]),
    logicalW: pick(["logicalW", "LOGICAL_W"]),
    logicalH: pick(["logicalH", "LOGICAL_H"]),
    windowW: pick(["windowW", "WINDOW_W", "winW"]),
    windowH: pick(["windowH", "WINDOW_H", "winH"]),
    drawX: pick(["gameDrawX", "GAME_DRAW_X", "drawX"]),
    drawY: pick(["gameDrawY", "GAME_DRAW_Y", "drawY"]),
    drawW: pick(["gameDrawW", "GAME_DRAW_W", "drawW"]),
    drawH: pick(["gameDrawH", "GAME_DRAW_H", "drawH"]),
  };
}

export function isViewportMappable(vp) {
  return Boolean(vp)
    && (vp.ok === 1 || vp.ok === true)
    && vp.logicalW > 0 && vp.logicalH > 0
    && vp.windowW > 0 && vp.windowH > 0
    && vp.drawW > 0 && vp.drawH > 0
    && vp.drawX !== null && vp.drawY !== null;
}

// client (parent-page CSS px) -> logical game pixels, through the SAME affine
// transform the engine's backend uses (canvas CSS px -> backing px -> the real
// GAME_DRAW rect -> logical dims). `canvasRect` is the engine canvas's
// getBoundingClientRect() already offset into parent-page coordinates. Returns
// null when unmappable OR when the point falls OUTSIDE the drawn rect (a click
// in the letterbox bars is not a game click).
export function mapClientToLogical(client, viewport, canvasRect) {
  const vp = normalizeViewport(viewport);
  if (!isViewportMappable(vp) || !canvasRect) return null;
  const w = toNum(canvasRect.width) ?? 0;
  const h = toNum(canvasRect.height) ?? 0;
  if (!(w > 0) || !(h > 0)) return null;
  const px = (toNum(client.x) ?? 0) - (toNum(canvasRect.left) ?? 0);
  const py = (toNum(client.y) ?? 0) - (toNum(canvasRect.top) ?? 0);
  // CSS px -> canvas backing (WINDOW_*) px
  const cx = px * vp.windowW / w;
  const cy = py * vp.windowH / h;
  // Outside the real draw rect means a letterbox-bar click: not a game click.
  if (cx < vp.drawX || cx >= vp.drawX + vp.drawW || cy < vp.drawY || cy >= vp.drawY + vp.drawH) return null;
  const x = Math.round((cx - vp.drawX) * vp.logicalW / vp.drawW);
  const y = Math.round((cy - vp.drawY) * vp.logicalH / vp.drawH);
  if (x < 0 || x >= vp.logicalW || y < 0 || y >= vp.logicalH) return null;
  return { x, y, source: "draw-rect" };
}

// --- Gump / UI blocking -----------------------------------------------------
// If W2 publishes gump rect slots (63+), a click inside any rect is blocked.
// If those slots are absent, block whenever an existing modal/text/gump
// indicator is set; and if NO such indicator exists at all, stay conservative
// and block (the contract's explicit fallback).
export function readGumpRects(snapshot) {
  if (snapshot == null) return null;
  const count = readSlot(snapshot, "GUMP_COUNT", PATH_SLOTS.GUMP_COUNT);
  if (count === null) return null; // slot absent => caller takes the conservative path
  const n = Math.max(0, Math.min(PATH_SLOTS.GUMP_RECT_MAX, count | 0));
  const rects = [];
  for (let i = 0; i < n; i++) {
    // W2 publishes one flat run of GUMP_RECT_0..15 (slots 64..79): four
    // consecutive slots (x,y,w,h) per rect, so rect i occupies names
    // GUMP_RECT_{4i}..{4i+3}.
    const base = i * PATH_SLOTS.GUMP_RECT_FIELDS;
    const x = readSlot(snapshot, `GUMP_RECT_${base}`, PATH_SLOTS.GUMP_RECT_BASE + base);
    const y = readSlot(snapshot, `GUMP_RECT_${base + 1}`, PATH_SLOTS.GUMP_RECT_BASE + base + 1);
    const w = readSlot(snapshot, `GUMP_RECT_${base + 2}`, PATH_SLOTS.GUMP_RECT_BASE + base + 2);
    const h = readSlot(snapshot, `GUMP_RECT_${base + 3}`, PATH_SLOTS.GUMP_RECT_BASE + base + 3);
    if (x === null || y === null || w === null || h === null) continue;
    rects.push({ x, y, w, h });
  }
  return rects;
}

export function pointInRect(point, rect) {
  return Boolean(point) && Boolean(rect)
    && point.x >= rect.x && point.x < rect.x + rect.w
    && point.y >= rect.y && point.y < rect.y + rect.h;
}

// Does the click point land on a native gump? When the engine exports gump
// rects we test them precisely; otherwise we fall back to blocking whenever any
// UI indicator is set, and — if there is no indicator signal at all — block.
export function gumpBlocks(point, gumpRects, indicators = {}) {
  if (Array.isArray(gumpRects)) {
    if (gumpRects.length === 0) return false; // exported, and nothing is up
    return gumpRects.some((r) => pointInRect(point, r));
  }
  // Slots 63+ absent: block whenever any existing modal/text/gump indicator is
  // set, and stay conservative (block) when no indicator signal exists at all.
  // Both clauses resolve to "block", so an unresolvable frame is never walked
  // through blindly. The caller has already applied the blocked_when clauses
  // (stasis / text-input / mode) before reaching here.
  return true;
}

// --- blocked_when -----------------------------------------------------------
// Returns the first blocking clause, or null when the click may proceed. A
// blocked click does nothing and never acquires a pause lease (the caller must
// not touch the lease on this path).
export function clickBlockReason(ctx = {}) {
  const c = ctx;
  if (c.available === false) return "unavailable";
  if (boolTrue(c.stasis)) return "stasis";
  if (boolTrue(c.textInputActive)) return "text-input";
  if (boolTrue(c.pauseLease)) return "pause-lease";
  if (boolTrue(c.mapOpen)) return "map";
  const play = c.playScreen ?? PLAY_SCREEN;
  if (c.screen !== undefined && c.screen !== play) return "screen";
  if (c.normalPlayMode === false) return "mode";
  if (c.ready === false || c.ready === 0) return "not-ready";
  const point = c.point ?? null;
  if (boolTrue(c.onShellUi)) return "shell-ui";
  if (gumpBlocks(point, c.gumpRects ?? null, {
    stasis: c.stasis, textInputActive: c.textInputActive, modal: c.modal, gump: c.gump,
  })) return "gump";
  return null;
}

// --- Setting ----------------------------------------------------------------
// "Click to move": default ON for mouse, OFF for touch (the stick stays
// primary this phase), forced OFF in Classic (also via the schema enhancement
// off-value, this is the belt-and-braces gate the click path consults).
export function effectiveClickToMove(settings, env = {}) {
  if (!settings) return false;
  if (settings.mode === "classic") return false;
  if (env.touchPrimary) return false;
  return settings.clickToMove === true;
}

// --- Cancel sources ---------------------------------------------------------
export const CANCEL = Object.freeze({
  MOVE_KEY: "move-key",
  STICK: "stick",
  ESCAPE: "escape",
  PAUSE: "pause",
  SECOND_INPUT: "second-input",
  RETARGET: "retarget",
  DOUBLE_CLICK: "double-click",
  DIALOGUE: "dialogue",
  MAP: "map",
  DEATH: "death",
});

// --- Walk state machine -----------------------------------------------------
// Thin, testable controller: classifies clicks, retargets, cancels a pending
// walk on a double click, and remembers the destination for the marker. It
// delegates the actual engine calls to injected walkTo/cancelWalk so tests use
// a mock bridge and the shell uses the real one.
export function createClickMover(deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const walkTo = deps.walkTo ?? (() => 0);
  const cancelWalk = deps.cancelWalk ?? (() => 0);
  const doubleMs = deps.doubleMs ?? DOUBLE_CLICK_MS;
  let active = null;          // { x, y, seq, map, at }
  let lastClickAt = -Infinity;
  let seq = 0;

  function handleClick(logical, at = now(), map = null) {
    const target = { x: logical.x | 0, y: logical.y | 0 };
    const isDouble = (at - lastClickAt) <= doubleMs;
    lastClickAt = at;
    if (isDouble && active) return cancel(CANCEL.DOUBLE_CLICK);
    let accepted = 1;
    try { accepted = walkTo(target.x, target.y); } catch { accepted = 0; }
    // W2's walkTo returns 1 accepted / 0 rejected.
    if (accepted === 0 || accepted === false) { active = null; return { kind: "rejected", ...target }; }
    seq += 1;
    active = { ...target, seq, map, at };
    return { kind: "walk", ...target, seq };
  }

  function cancel(reason) {
    if (!active) return { kind: "noop", reason };
    try { cancelWalk(); } catch { /* idempotent */ }
    active = null;
    lastClickAt = -Infinity;   // a cancel is not half of a double click
    return { kind: "cancel", reason };
  }

  return {
    handleClick,
    cancel,
    isActive: () => active !== null,
    target: () => (active ? { x: active.x, y: active.y, seq: active.seq } : null),
    seq: () => seq,
  };
}

// Transitions that must cancel a pending walk while the engine advances:
// dialogue/stasis start, a map change, or death. Pure: returns the cancel
// reason or null.
export function reconcileCancel(active, snapshot) {
  if (!active || snapshot == null) return null;
  if (toNum(snapshot.STASIS) === 1) return CANCEL.DIALOGUE;
  if (toNum(snapshot.DEAD) === 1) return CANCEL.DEATH;
  const map = toNum(snapshot.MAP_NUM);
  if (active.map !== null && active.map !== undefined && map !== null && map !== active.map) return CANCEL.MAP;
  return null;
}

// --- Marker mapping ---------------------------------------------------------
// Destination marker while the engine walks; a brief "can't reach" marker on
// failure. Driven by PATH_STATE; PATH_SEQ identifies a fresh request.
export function markerKindFor(pathState) {
  if (pathState === PATH_STATE.ACTIVE) return "destination";
  if (pathState === PATH_STATE.FAILED) return "unreachable";
  return null;
}

export function markerShouldClear(pathState) {
  return pathState === PATH_STATE.UNAVAILABLE
    || pathState === PATH_STATE.IDLE
    || pathState === PATH_STATE.ARRIVED
    || pathState === PATH_STATE.CANCELLED;
}
