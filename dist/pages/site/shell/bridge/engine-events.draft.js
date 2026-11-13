// shell/bridge/engine-events.draft.js  —  DRAFT, interface only.
// Numeric ScummVM/Ultima8 constants and pure encoders for Common::Event
// injection. No engine calls, no DOM/window/fetch, no wasm import: this only
// builds plain command objects for a future Emscripten glue to feed to the
// exports listed in docs/bridge-draft.md §8.
//
// Source of truth: vendor/scummvm @ 929be885.
//   common/events.h:50-95          EventType values
//   common/events.h:218-263        Event struct fields (type/kbd/mouse/customType)
//   common/keyboard.h:294-330      KeyState (keycode/ascii/flags); KBD_* 277-279
//   engines/ultima/ultima8/metaengine.h:31-52   KeybindingAction enum (sequential)
//   engines/ultima/ultima8/world/actors/avatar_mover_process.h:69-103  MovementFlags

// ---------------------------------------------------------------------------
// EventType numeric values (common/events.h:50-90). Only the ones the bridge uses.
// ---------------------------------------------------------------------------
export const EVENT = Object.freeze({
  KEYDOWN: 1,                      // :52
  KEYUP: 2,                        // :54
  MOUSEMOVE: 3,                    // :56
  LBUTTONDOWN: 4, LBUTTONUP: 5,    // :57-58
  RBUTTONDOWN: 6, RBUTTONUP: 7,    // :59-60
  MBUTTONDOWN: 13, MBUTTONUP: 14,  // :63-64
  CUSTOM_ENGINE_ACTION_START: 20,  // :89
  CUSTOM_ENGINE_ACTION_END: 21,    // :90
});

// KBD_* modifier bits (common/keyboard.h:277-279).
export const KBD = Object.freeze({ CTRL: 1 << 0, ALT: 1 << 1, SHIFT: 1 << 2 });

// Mouse buttons, ScummVM order (common/events.h:225-232); maps to Mouse::BUTTON_*.
export const MOUSE = Object.freeze({ left: "left", right: "right", middle: "middle" });

// ---------------------------------------------------------------------------
// KeybindingAction numeric values (engines/ultima/ultima8/metaengine.h:31-52).
// The enum has no explicit initialisers, so values are sequential from 0.
// ---------------------------------------------------------------------------
export const KA = Object.freeze({
  QUICKSAVE: 0, SAVE: 1, LOAD: 2, BEDROLL: 3, COMBAT: 4,
  BACKPACK: 5, KEYRING: 6, MINIMAP: 7, RECALL: 8, INVENTORY: 9,
  NEXT_WEAPON: 10, NEXT_INVENTORY: 11, USE_INVENTORY: 12, USE_MEDIKIT: 13,
  USE_ENERGYCUBE: 14, SELECT_ITEMS: 15, DETONATE_BOMB: 16, DROP_WEAPON: 17,
  USE_SELECTION: 18, GRAB_ITEMS: 19, MENU: 20, CLOSE_GUMPS: 21,
  HIGHLIGHT_ITEMS: 22, TOGGLE_TOUCHING: 23, JUMP: 24, SHORT_JUMP: 25,
  TURN_LEFT: 26, TURN_RIGHT: 27, MOVE_FORWARD: 28, MOVE_BACK: 29,
  MOVE_UP: 30, MOVE_DOWN: 31, MOVE_LEFT: 32, MOVE_RIGHT: 33, MOVE_RUN: 34,
  MOVE_STEP: 35, ATTACK: 36, STEP_LEFT: 37, STEP_RIGHT: 38, STEP_FORWARD: 39,
  STEP_BACK: 40, ROLL_LEFT: 41, ROLL_RIGHT: 42, TOGGLE_CROUCH: 43,
  CAMERA_AVATAR: 44, CLIPPING: 45, DEC_SORT_ORDER: 46, INC_SORT_ORDER: 47,
  MOVE_ASCEND: 48, MOVE_DESCEND: 49, TOGGLE_PAINT: 50, FRAME_BY_FRAME: 51,
  ADVANCE_FRAME: 52, TOGGLE_STASIS: 53, SHAPE_VIEWER: 54, NONE: 55,
});

// NOTE: ACTION_ATTACK is 36 but is only bound in CRUSADER_KEYS ("Fire weapon",
// SPACE/KP0 — metaengine.cpp:89). U8 has no attack/kick/block key at all; those
// three are pointer gestures (see BRIDGE_INTENT below). Do NOT emit
// engineAction(KA.ATTACK) for the core ATTACK action.
export const CRUSADER_ONLY_ATTACK = KA.ATTACK;

// MovementFlags bit values (avatar_mover_process.h:69-103). Re-exported so the
// action map can document which flag each core direction sets.
export const MOVE_FLAG = Object.freeze({
  MOUSE_DIRECTION: 0x001, RUN: 0x0002, STEP: 0x0004, JUMP: 0x0008,
  TURN_LEFT: 0x0010, TURN_RIGHT: 0x0020, FORWARD: 0x0040, BACK: 0x0080,
  LEFT: 0x0100, RIGHT: 0x0200, UP: 0x0400, DOWN: 0x0800,
  ATTACKING: 0x1000,
});

const isInt = (v) => typeof v === "number" && Number.isInteger(v);

// ---------------------------------------------------------------------------
// Encoders. Each returns a { kind, event } command for the glue's pushEvent.
// ---------------------------------------------------------------------------

// Custom engine action: the path the keymapper itself produces and the only
// non-modal route into handleActionDown/Up (ultima8.cpp:860-865). Artificial
// events skip the keymapper (common/events.h:315), so this must carry the
// numeric action, never a raw key.
export function engineAction(action, down = true) {
  if (!isInt(action) || action < 0 || action > KA.NONE) {
    throw new Error(`engine action out of range: ${action}`);
  }
  return {
    kind: "pushEvent",
    event: {
      type: down ? EVENT.CUSTOM_ENGINE_ACTION_START : EVENT.CUSTOM_ENGINE_ACTION_END,
      customType: action,
    },
  };
}

// Raw key event (type/keycode/ascii/flags). Note: non-modal KEYDOWN is ignored
// by handleEvent (ultima8.cpp:782-821); use it only for modal text input.
export function keyEvent(keycode, ascii, flags, down = true) {
  return {
    kind: "pushEvent",
    event: { type: down ? EVENT.KEYDOWN : EVENT.KEYUP, kbd: { keycode, ascii, flags: flags | 0 } },
  };
}

// Mouse move: routed to Mouse::setMouseCoords (ultima8.cpp:828-830).
export function mouseMove(x, y) {
  return { kind: "pushEvent", event: { type: EVENT.MOUSEMOVE, mouse: { x: x | 0, y: y | 0 } } };
}

// Mouse button: routed to Mouse::buttonDown/Up (ultima8.cpp:832-858). Movement
// in U8 normal mode requires the right button held with a direction-bearing
// cursor position (u8_avatar_mover_process.cpp:352-362, 542-556).
export function mouseButton(button, x, y, down = true) {
  const type = {
    left: down ? EVENT.LBUTTONDOWN : EVENT.LBUTTONUP,
    right: down ? EVENT.RBUTTONDOWN : EVENT.RBUTTONUP,
    middle: down ? EVENT.MBUTTONDOWN : EVENT.MBUTTONUP,
  }[button];
  if (!type) throw new Error(`unknown mouse button: ${button}`);
  return { kind: "pushEvent", event: { type, mouse: { x: x | 0, y: y | 0 } } };
}

// ---------------------------------------------------------------------------
// Named queued intents for U8 capabilities that are NOT single engine actions.
//
// U8 avatar combat/interaction is driven by mouse gesture + timing, not by a
// keybinding: hold left = block (u8_avatar_mover_process.cpp:137-155), double
// left = attack (:156-176), double right = kick (:191-207), double right on the
// avatar = toggle combat (:178-190), world-object double left = use
// (gumps/game_map_gump.cpp:339-381), single left = look (dispatched only after
// the double-click window; kernel/mouse.cpp:540-568).
//
// The engine detects a double-click only when the second down is unhandled and
// within Mouse::getDoubleClickTime() of the first (kernel/mouse.h:67-69). Two
// down/up pairs drained in one poll therefore do NOT reliably form a
// double-click — the timestamps and MBS_HANDLED state must be real. So the
// bridge emits these named, explicitly gated intent commands and a future
// engine adapter performs them with the cited hold/double-click timing. No DOM
// and no engine call happens here.
// ---------------------------------------------------------------------------
export const BRIDGE_INTENT = Object.freeze({
  BLOCK_HOLD:            "u8.block.holdLeft",            // :137-155; release -> stopBlock :113-118
  ATTACK_DOUBLECLICK:    "u8.attack.doubleClickLeft",    // :156-176; gated by canAttack() :782-796
  KICK_DOUBLECLICK:      "u8.kick.doubleClickRight",     // :191-207; gated by canAttack()
  COMBAT_TOGGLE_DOUBLECLICK: "u8.combatToggle.doubleClickRightOnAvatar", // :178-190
  USE_OBJECT_DOUBLECLICK: "u8.use.doubleClickLeftOnObject",  // game_map_gump.cpp:339-381
  LOOK_OBJECT_CLICK:     "u8.look.singleClickLeftOnObject",  // game_map_gump.cpp:293-335, delayed
  MOVE_TO_MIDDLECLICK:   "u8.move.singleClickMiddle",        // game_map_gump.cpp:314-334 pathfind
  PICK_UP_DRAG:          "u8.pickUp.dragLeft",               // game_map_gump.cpp:381-401 drag
});

// The engine's own double-click window: Mouse::getDoubleClickTime() returns the
// backend value, defaulting to 400 ms when the surface reports 0
// (kernel/mouse.cpp:536-539). This constant is only a hint for planners; the
// adapter must read the live value.
export const DOUBLE_CLICK_HINT_MS = 400;

// Build a named, gated intent (never an engine call). `params` may carry a
// button, target point, or hold/release flag the adapter needs.
export function bridgeIntent(intent, params = {}) {
  if (typeof intent !== "string" || intent.length === 0) {
    throw new Error(`bridge intent must be a non-empty string: ${intent}`);
  }
  return { kind: "intent", intent, gated: true, ...params };
}

// ---------------------------------------------------------------------------
// Bounded FIFO. The engine only drains events at its frame boundary
// (ultima8.cpp:666); the JS side must never re-enter the engine, so it just
// enqueues here and lets the glue flush on the next pumped frame.
// ---------------------------------------------------------------------------
export const DEFAULT_QUEUE_LIMIT = 256;

export function createCommandQueue(limit = DEFAULT_QUEUE_LIMIT) {
  const items = [];
  let dropped = 0;
  return {
    enqueue(cmd) {
      if (items.length >= limit) {
        dropped += 1;
        return false;
      }
      items.push(cmd);
      return true;
    },
    // Returns the whole batch at once; the glue maps each `kind` onto a §8 export.
    flush() {
      return items.splice(0, items.length);
    },
    get size() { return items.length; },
    get dropped() { return dropped; },
  };
}

export function isEngineCommand(cmd) {
  return Boolean(cmd) && typeof cmd === "object"
    && (cmd.kind === "pushEvent" || cmd.kind === "engine"
        || cmd.kind === "state" || cmd.kind === "intent");
}
