// shell/core/inputmap.js
// Pure keyboard/gamepad/touch -> action mapping with Modern & Classic bindings,
// 8-way stick quantisation and rebinding with conflict detection.
import { ACTIONS, MOVE_ACTIONS } from "./actions.js";

export const DEVICE = Object.freeze({ keyboard: "keyboard", gamepad: "gamepad", touch: "touch" });
export const DEFAULT_DEADZONE = 0.25;

const A = ACTIONS;

// Direction angles in screen space (y grows downward).
const DIR_ANGLES = Object.freeze([
  [A.MOVE_EAST, 0],
  [A.MOVE_SOUTH_EAST, Math.PI / 4],
  [A.MOVE_SOUTH, Math.PI / 2],
  [A.MOVE_SOUTH_WEST, (3 * Math.PI) / 4],
  [A.MOVE_WEST, Math.PI],
  [A.MOVE_NORTH_WEST, (-3 * Math.PI) / 4],
  [A.MOVE_NORTH, -Math.PI / 2],
  [A.MOVE_NORTH_EAST, -Math.PI / 4],
]);

const MODERN = {
  mode: "modern",
  keyboard: {
    KeyW: A.MOVE_NORTH, KeyS: A.MOVE_SOUTH, KeyA: A.MOVE_WEST, KeyD: A.MOVE_EAST,
    Numpad8: A.MOVE_NORTH, Numpad2: A.MOVE_SOUTH, Numpad4: A.MOVE_WEST, Numpad6: A.MOVE_EAST,
    Numpad7: A.MOVE_NORTH_WEST, Numpad9: A.MOVE_NORTH_EAST,
    Numpad1: A.MOVE_SOUTH_WEST, Numpad3: A.MOVE_SOUTH_EAST,
    ShiftLeft: A.RUN, Space: A.JUMP, KeyC: A.CLIMB, KeyF: A.ATTACK, KeyK: A.KICK,
    KeyB: A.BLOCK, KeyE: A.USE, KeyG: A.PICK_UP, KeyI: A.INVENTORY,
    KeyT: A.COMBAT_TOGGLE, F5: A.QUICK_SAVE, F9: A.QUICK_LOAD, KeyM: A.MENU, Escape: A.PAUSE,
  },
  gamepad: {
    0: A.JUMP, 1: A.ATTACK, 2: A.USE, 3: A.INVENTORY, 4: A.BLOCK, 5: A.RUN,
    6: A.KICK, 8: A.MENU, 9: A.PAUSE, 12: A.MOVE_NORTH, 13: A.MOVE_SOUTH,
    14: A.MOVE_WEST, 15: A.MOVE_EAST,
  },
  touch: {
    buttonA: A.ATTACK, buttonB: A.JUMP, buttonC: A.USE, buttonD: A.BLOCK,
    buttonRun: A.RUN, buttonInv: A.INVENTORY, buttonMenu: A.MENU,
  },
};

// Classic does not provision abstract keyboard bindings. Instead it sets a
// `passthrough` flag: the shell sends raw keyboard input to the engine
// unchanged, so the engine keeps its own native defaults. Documented in
// CLASSIC_PASSTHROUGH below (F1 quicksave, F5 save, F7 load, Space jump —
// per ultima8/metaengine.cpp U8_KEYS; Space is jump, not attack). Gamepad and
// touch keep explicit bindings so mobile stays usable.
const CLASSIC = {
  mode: "classic",
  passthrough: true,
  keyboard: {},
  gamepad: {
    0: A.JUMP, 1: A.ATTACK, 2: A.USE, 3: A.INVENTORY, 4: A.BLOCK, 5: A.RUN,
    8: A.MENU, 9: A.PAUSE, 12: A.MOVE_NORTH, 13: A.MOVE_SOUTH,
    14: A.MOVE_WEST, 15: A.MOVE_EAST,
  },
  touch: {
    buttonA: A.JUMP, buttonB: A.ATTACK, buttonC: A.USE, buttonD: A.BLOCK,
    buttonRun: A.RUN, buttonInv: A.INVENTORY, buttonMenu: A.MENU,
  },
};

const MODES = Object.freeze({ modern: MODERN, classic: CLASSIC });

function deepCopy(layout) {
  const copy = { mode: layout.mode };
  if (layout.passthrough) copy.passthrough = true;
  for (const device of Object.values(DEVICE)) copy[device] = { ...layout[device] };
  return copy;
}

// A PROVISIONAL hint (not a keymap): the engine-native U8 keyboard defaults
// Classic mode preserves. The shell forwards these (and every other key) to the
// engine verbatim. Source: ultima8/metaengine.cpp U8_KEYS — Space = jump.
export const CLASSIC_PASSTHROUGH = Object.freeze({
  passthrough: true,
  keys: Object.freeze([
    { key: "F1", meaning: "quicksave" },
    { key: "F5", meaning: "save" },
    { key: "F7", meaning: "load" },
    { key: "Space", meaning: "jump" },
  ]),
});

export function isPassthrough(bindings) {
  return bindings?.passthrough === true;
}

export function getBindings(mode = "modern") {
  const base = MODES[mode];
  if (!base) throw new Error(`unknown control mode: ${mode}`);
  return deepCopy(base);
}

export function defaultBindings() {
  return { modern: getBindings("modern"), classic: getBindings("classic") };
}

// --- Stateless lookups ------------------------------------------------------
export function mapKey(bindings, code) {
  if (!code || typeof code !== "string") return null;
  return bindings?.keyboard?.[code] ?? null;
}

export function mapGamepadButton(bindings, index) {
  if (index === undefined || index === null) return null;
  return bindings?.gamepad?.[index] ?? bindings?.gamepad?.[String(index)] ?? null;
}

export function mapTouchButton(bindings, id) {
  if (!id) return null;
  return bindings?.touch?.[id] ?? null;
}

// Snap a virtual stick vector to one of 8 move actions (or null in dead zone).
export function quantizeStick(x, y, deadzone = DEFAULT_DEADZONE) {
  const nx = Number(x) || 0;
  const ny = Number(y) || 0;
  const mag = Math.hypot(nx, ny);
  if (mag < deadzone) return null;
  const angle = Math.atan2(ny, nx);
  let best = DIR_ANGLES[0];
  let bestDiff = Math.PI * 2;
  for (const pair of DIR_ANGLES) {
    let diff = Math.abs(angle - pair[1]);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    if (diff < bestDiff) { bestDiff = diff; best = pair; }
  }
  return best[0];
}

export function mapGamepadStick(bindings, x, y, deadzone = DEFAULT_DEADZONE) {
  return quantizeStick(x, y, deadzone);
}

// Abstract touch event -> action.
//  {kind:'stick', x, y, deadzone?}
//  {kind:'button', id, phase:'tap'|'hold'}
//  {kind:'drag', id?, x, y, dx, dy}   -> direction from vector
export function mapTouch(bindings, event) {
  if (!event || typeof event !== "object") return null;
  if (event.kind === "stick") {
    return quantizeStick(event.x, event.y, event.deadzone ?? DEFAULT_DEADZONE);
  }
  if (event.kind === "button") {
    return mapTouchButton(bindings, event.id);
  }
  if (event.kind === "drag") {
    if (typeof event.dx === "number" || typeof event.dy === "number") {
      const dir = quantizeStick(event.dx ?? 0, event.dy ?? 0, event.deadzone ?? DEFAULT_DEADZONE);
      if (dir) return dir;
    }
    return event.id ? mapTouchButton(bindings, event.id) : null;
  }
  if (event.kind === "tap" || event.kind === "hold") {
    return mapTouchButton(bindings, event.id);
  }
  return null;
}

// --- Rebinding with conflict detection --------------------------------------
export function detectConflict(bindings, device, code, ignoreAction = null) {
  const table = bindings?.[device];
  if (!table) return null;
  const existing = table[code] ?? table[String(code)];
  if (!existing) return null;
  if (ignoreAction && existing === ignoreAction) return null;
  return existing;
}

// Immutable rebind. Returns {ok, bindings, conflict} where `bindings` is a copy.
export function rebind(bindings, options) {
  const { device, code, action } = options ?? {};
  if (!Object.values(DEVICE).includes(device)) {
    return { ok: false, conflict: "invalid device", bindings };
  }
  if (code === undefined || code === null || code === "") {
    return { ok: false, conflict: "missing key/button code", bindings };
  }
  if (!Object.values(ACTIONS).includes(action)) {
    return { ok: false, conflict: `unknown action: ${action}`, bindings };
  }
  const conflict = detectConflict(bindings, device, code, action);
  if (conflict) {
    return { ok: false, conflict, bindings };
  }
  const next = deepCopy(bindings);
  for (const [existingCode, existingAction] of Object.entries(next[device])) {
    if (existingAction === action) delete next[device][existingCode];
  }
  next[device][code] = action;
  return { ok: true, conflict: null, bindings: next };
}

export function listMoveActions() {
  return [...MOVE_ACTIONS];
}
