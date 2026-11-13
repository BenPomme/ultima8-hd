// shell/bridge/action-map.draft.js  —  DRAFT, interface only.
// Maps the accepted core `ACTIONS` (shell/core/actions.js) onto concrete
// engine commands and named queued intents, and builds state/save/speed/option
// requests. Pure ES module; it emits command objects only, never calling the
// engine and never touching the DOM. See docs/bridge-draft.md §4-§8 for the
// file:line citations behind each entry.
import { ACTIONS } from "../core/actions.js";
import {
  EVENT, KA, engineAction, mouseMove, mouseButton,
  BRIDGE_INTENT, bridgeIntent,
} from "./engine-events.draft.js";

// Resolution status per core action, so callers never mistake a fallback for a
// faithful binding:
//   "exact"         direct engine action/keybinding
//   "queued-intent" capability exists in U8 but only as a timed mouse gesture,
//                   so the bridge emits a named gated intent (§ engine-events)
//   "approximate"   closest available action differs in kind
export const RESOLUTION = Object.freeze({
  MOVE_NORTH: "exact", MOVE_SOUTH: "exact", MOVE_WEST: "exact", MOVE_EAST: "exact",
  MOVE_NORTH_EAST: "exact", MOVE_NORTH_WEST: "exact",
  MOVE_SOUTH_EAST: "exact", MOVE_SOUTH_WEST: "exact",
  RUN: "exact", JUMP: "exact", CLIMB: "approximate",
  ATTACK: "queued-intent", KICK: "queued-intent", BLOCK: "queued-intent",
  USE: "queued-intent", PICK_UP: "queued-intent", INVENTORY: "exact",
  COMBAT_TOGGLE: "exact", QUICK_SAVE: "exact", QUICK_LOAD: "approximate",
  MENU: "exact", PAUSE: "approximate",
});

// Core 8-way directions -> engine KeybindingAction numbers. The engine ORs the
// movement flags then derives the direction from the axes
// (u8_avatar_mover_process.cpp:598-603); diagonals are two flags held together.
const DIR_ACTIONS = Object.freeze({
  [ACTIONS.MOVE_NORTH]: [KA.MOVE_UP],
  [ACTIONS.MOVE_SOUTH]: [KA.MOVE_DOWN],
  [ACTIONS.MOVE_WEST]: [KA.MOVE_LEFT],
  [ACTIONS.MOVE_EAST]: [KA.MOVE_RIGHT],
  [ACTIONS.MOVE_NORTH_EAST]: [KA.MOVE_UP, KA.MOVE_RIGHT],
  [ACTIONS.MOVE_NORTH_WEST]: [KA.MOVE_UP, KA.MOVE_LEFT],
  [ACTIONS.MOVE_SOUTH_EAST]: [KA.MOVE_DOWN, KA.MOVE_RIGHT],
  [ACTIONS.MOVE_SOUTH_WEST]: [KA.MOVE_DOWN, KA.MOVE_LEFT],
});

// Single engine action per core action where the binding is direct.
const SINGLE_ACTIONS = Object.freeze({
  [ACTIONS.RUN]: KA.MOVE_RUN,
  [ACTIONS.JUMP]: KA.JUMP,
  [ACTIONS.INVENTORY]: KA.INVENTORY,
  [ACTIONS.COMBAT_TOGGLE]: KA.COMBAT,
  [ACTIONS.QUICK_SAVE]: KA.QUICKSAVE,
  [ACTIONS.MENU]: KA.MENU,
});

// Ops served by a per-frame command inbox (bridge_queue_command, doc §8.3):
// de-duplicated, single-shot, and always run at the frame boundary.
export const ENGINE_OP = Object.freeze({
  SAVE: "save", LOAD: "load", PAUSE: "pause", SET_SPEED: "setGameSpeed", SET_OPTION: "setOption",
});

// On-screen cursor point that lies in `dir` from the avatar reference point.
// The engine reads direction from the cursor position relative to screen centre
// (kernel/mouse.cpp:185-193), so pointer movement is expressed as a point.
const DIR_OFFSETS = Object.freeze({
  [ACTIONS.MOVE_NORTH]: [0, -32], [ACTIONS.MOVE_SOUTH]: [0, 32],
  [ACTIONS.MOVE_WEST]: [-32, 0], [ACTIONS.MOVE_EAST]: [32, 0],
  [ACTIONS.MOVE_NORTH_EAST]: [32, -32], [ACTIONS.MOVE_NORTH_WEST]: [-32, -32],
  [ACTIONS.MOVE_SOUTH_EAST]: [32, 32], [ACTIONS.MOVE_SOUTH_WEST]: [-32, 32],
});

function pointerMove(action, ctx, down) {
  const [dx, dy] = DIR_OFFSETS[action];
  const x = (ctx.x || 0) + dx;
  const y = (ctx.y || 0) + dy;
  // Emit the matching right mouse DOWN *and* UP at the same point. Without the
  // UP on release the engine keeps MOVE_MOUSE_DIRECTION set while the right
  // button is MBS_DOWN (u8_avatar_mover_process.cpp:375-382), so the avatar
  // keeps walking. Never fall back to a bare custom-action END here.
  return [mouseMove(x, y), mouseButton("right", x, y, down)];
}

// Normalised pointer point for an intent, or null when the caller gave none.
function pointOf(ctx) {
  if (ctx.target && Number.isFinite(ctx.target.x) && Number.isFinite(ctx.target.y)) {
    return { x: ctx.target.x | 0, y: ctx.target.y | 0 };
  }
  if (Number.isFinite(ctx.x) && Number.isFinite(ctx.y)) {
    return { x: ctx.x | 0, y: ctx.y | 0 };
  }
  return null;
}

// Plan the engine commands for one core action. `down` distinguishes hold/release
// for held actions (movement, run). Returns [] for unresolved actions.
export function planAction(action, ctx = {}) {
  const down = ctx.down !== undefined ? Boolean(ctx.down) : true;
  if (Object.prototype.hasOwnProperty.call(DIR_ACTIONS, action)) {
    // Optional pointer route: hold the right button toward a screen direction.
    // Both press and release go through the pointer path so the release emits a
    // right-button UP at the same point (otherwise movement sticks).
    if (ctx.pointer === true) return pointerMove(action, ctx, down);
    return DIR_ACTIONS[action].map((n) => engineAction(n, down));
  }
  if (Object.prototype.hasOwnProperty.call(SINGLE_ACTIONS, action)) {
    return [engineAction(SINGLE_ACTIONS[action], down)];
  }
  switch (action) {
    case ACTIONS.CLIMB:
      // No dedicated climb action; U8 climbs only as a jump follow-up.
      return [engineAction(KA.JUMP, down)];
    case ACTIONS.ATTACK:
      // U8 DOES have an attack, but it is NOT ACTION_ATTACK 36 — that number is
      // bound only in CRUSADER_KEYS ("Fire weapon", metaengine.cpp:90). In U8 an
      // avatar attacks on a left DOUBLE-click while in combat mode
      // (u8_avatar_mover_process.cpp:156-176), gated by the canAttack()
      // dexterity recovery (:782-796). A lone left click only looks, and is
      // dispatched as onMouseClick only after the double-click window
      // (kernel/mouse.cpp:540-568). Emit a named intent: the adapter must time a
      // real double-click; do not fake one with two down/up pairs in one poll.
      return down
        ? [bridgeIntent(BRIDGE_INTENT.ATTACK_DOUBLECLICK, { button: "left", point: pointOf(ctx) })]
        : [];
    case ACTIONS.KICK:
      // Double right-click in combat = kick (u8_avatar_mover_process.cpp:191-207);
      // double right-click ON the avatar toggles combat instead (:178-190).
      return down
        ? [bridgeIntent(BRIDGE_INTENT.KICK_DOUBLECLICK, { button: "right", point: pointOf(ctx) })]
        : [];
    case ACTIONS.BLOCK:
      // Left click-and-hold = block (u8_avatar_mover_process.cpp:137-155);
      // releasing while blocking plays stopBlock (:113-118).
      return [bridgeIntent(BRIDGE_INTENT.BLOCK_HOLD, { button: "left", down, point: pointOf(ctx) })];
    case ACTIONS.USE:
      // Using a world object is a left DOUBLE-click (game_map_gump.cpp:339-381
      // onMouseDouble -> item->use()); a single click only looks.
      return down
        ? [bridgeIntent(BRIDGE_INTENT.USE_OBJECT_DOUBLECLICK, { button: "left", point: pointOf(ctx) })]
        : [];
    case ACTIONS.PICK_UP:
      // Items are selected/dragged with the mouse (game_map_gump.cpp:381-401);
      // the adapter needs a timed down/move/up sequence.
      return down
        ? [bridgeIntent(BRIDGE_INTENT.PICK_UP_DRAG, { button: "left", point: pointOf(ctx) })]
        : [];
    case ACTIONS.QUICK_LOAD:
      // No quickload action exists; ACTION_LOAD opens the load dialog.
      return [engineAction(KA.LOAD, down)];
    case ACTIONS.PAUSE:
      return down ? [{ kind: "engine", op: ENGINE_OP.PAUSE, value: 1 }]
                  : [{ kind: "engine", op: ENGINE_OP.PAUSE, value: 0 }];
    default:
      return [];
  }
}

export function planActions(actions, ctx = {}) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  for (const action of actions) out.push(...planAction(action, ctx));
  return out;
}

// ---- state / save / speed / options ---------------------------------------

export const STATE = Object.freeze({
  STR: "str", DEX: "dex", INT: "int", HP: "hp", MANA: "mana",
  MAX_HP: "maxHp", MAX_MANA: "maxMana",
  IN_COMBAT: "inCombat", DEAD: "dead", STASIS: "stasis", CONTROLLED: "controlled",
  MAP_NUM: "mapNum", AVATAR_MAP: "avatarMapNum",
});

// Queue a state read; the glue fills the cached value at the frame boundary and
// JS polls it (doc §5).
export function readState(field) {
  return { kind: "state", field };
}

export function saveOp(slot, desc, isAutosave = false) {
  return { kind: "engine", op: ENGINE_OP.SAVE, slot, desc, isAutosave: Boolean(isAutosave) };
}

export function loadOp(slot) {
  return { kind: "engine", op: ENGINE_OP.LOAD, slot };
}

export function pauseOp(paused) {
  return { kind: "engine", op: ENGINE_OP.PAUSE, value: paused ? 1 : 0 };
}

// Core gameSpeed is 0.25..4 (shell/core/settings.js). The engine period is
// _animationRate = 100 at 30fps (ultima8.h:113, ultima8.cpp:126), so speed maps
// inversely; the 1..400 period band keeps the game between ~7.5 and 3000 fps.
export function setGameSpeedOp(speed) {
  const s = Math.min(4, Math.max(0.25, Number(speed) || 1));
  const rate = Math.min(400, Math.max(1, Math.round(100 / s)));
  return { kind: "engine", op: ENGINE_OP.SET_SPEED, rate, speed: s };
}

export function setOptionOp(keyId, value) {
  return { kind: "engine", op: ENGINE_OP.SET_OPTION, key: keyId, value };
}

// Ordered export contract the build owner adds to the Emscripten platform leaf;
// mirrors docs/bridge-draft.md §8. Kept here so the glue and the plan stay in sync.
export const ENGINE_EXPORTS = Object.freeze([
  "bridge_push_event(int type, int a, int b, int c, int d)",
  "bridge_engine_action(int action, int down)",
  "bridge_queue_command(int cmd, int arg)",
  "bridge_read_state(int field)",
  "bridge_set_game_speed(double speed)",
  "bridge_set_option(int keyId, int value)",
  "bridge_pointer_gesture(int gesture, int x, int y)",
]);

// ---------------------------------------------------------------------------
// Minimal self-checks. Pure, no DOM, no engine, no I/O beyond an optional
// console.log when run directly:  node shell/bridge/action-map.draft.js
// Importing the module never runs them.
// ---------------------------------------------------------------------------
export function runSelfChecks() {
  const fail = (msg) => { throw new Error(`bridge self-check failed: ${msg}`); };
  const typeOf = (cmd) => (cmd && cmd.event ? cmd.event.type : undefined);

  // 1. Pointer movement must press and release the SAME right-button point, or
  //    the engine keeps MOVE_MOUSE_DIRECTION and the avatar walks forever.
  const ctx = { pointer: true, x: 120, y: 80 };
  const press = planAction(ACTIONS.MOVE_NORTH, { ...ctx, down: true });
  const release = planAction(ACTIONS.MOVE_NORTH, { ...ctx, down: false });
  const downCmd = press.find((c) => typeOf(c) === EVENT.RBUTTONDOWN);
  const upCmd = release.find((c) => typeOf(c) === EVENT.RBUTTONUP);
  if (!downCmd) fail("pointer press emits RBUTTONDOWN");
  if (!upCmd) fail("pointer release emits RBUTTONUP (otherwise movement sticks)");
  if (downCmd.event.mouse.x !== upCmd.event.mouse.x ||
      downCmd.event.mouse.y !== upCmd.event.mouse.y) {
    fail("pointer press/release use the same point");
  }
  if (release.some((c) => typeOf(c) === EVENT.CUSTOM_ENGINE_ACTION_END)) {
    fail("pointer release must not fall back to a bare custom-action END");
  }

  // 2. ATTACK must use U8 semantics (double-click-left intent) and must never be
  //    routed onto the Crusader-only ACTION_ATTACK numeric (36).
  if (KA.ATTACK !== 36) fail("ACTION_ATTACK numeric is 36 (Crusader-only)");
  const attack = planAction(ACTIONS.ATTACK, { target: { x: 10, y: 12 } });
  if (attack.some((c) => typeOf(c) === EVENT.CUSTOM_ENGINE_ACTION_START
      && c.event.customType === KA.ATTACK)) {
    fail("ATTACK must not emit custom engine action 36 (Crusader path)");
  }
  if (!attack.some((c) => c.kind === "intent" && c.intent === BRIDGE_INTENT.ATTACK_DOUBLECLICK)) {
    fail("ATTACK emits the u8 double-click-left intent");
  }

  // 3. KICK / BLOCK are real U8 gestures, not unresolved.
  const kick = planAction(ACTIONS.KICK, { target: { x: 1, y: 1 } });
  const blockDown = planAction(ACTIONS.BLOCK, { down: true });
  const blockUp = planAction(ACTIONS.BLOCK, { down: false });
  if (!kick.some((c) => c.intent === BRIDGE_INTENT.KICK_DOUBLECLICK)) fail("KICK is a double-right intent");
  if (blockDown[0].intent !== BRIDGE_INTENT.BLOCK_HOLD || blockDown[0].down !== true) fail("BLOCK down holds left");
  if (blockUp[0].down !== false) fail("BLOCK release pairs the hold");
  if (RESOLUTION.KICK === "unresolved" || RESOLUTION.BLOCK === "unresolved") fail("KICK/BLOCK are not unresolved");
  return true;
}

const invokedDirectly = typeof process !== "undefined" && process.argv
  && typeof process.argv[1] === "string" && process.argv[1].endsWith("action-map.draft.js");
if (invokedDirectly) {
  runSelfChecks();
  console.log("action-map.draft.js: self-checks passed");
}
