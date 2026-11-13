// shell/core/actions.js
// Enumerated abstract game actions. Pure ES module, no DOM/window/fetch.

export const ACTIONS = Object.freeze({
  MOVE_NORTH: "MOVE_NORTH",
  MOVE_SOUTH: "MOVE_SOUTH",
  MOVE_EAST: "MOVE_EAST",
  MOVE_WEST: "MOVE_WEST",
  MOVE_NORTH_EAST: "MOVE_NORTH_EAST",
  MOVE_NORTH_WEST: "MOVE_NORTH_WEST",
  MOVE_SOUTH_EAST: "MOVE_SOUTH_EAST",
  MOVE_SOUTH_WEST: "MOVE_SOUTH_WEST",
  RUN: "RUN",
  JUMP: "JUMP",
  CLIMB: "CLIMB",
  ATTACK: "ATTACK",
  KICK: "KICK",
  BLOCK: "BLOCK",
  USE: "USE",
  PICK_UP: "PICK_UP",
  INVENTORY: "INVENTORY",
  COMBAT_TOGGLE: "COMBAT_TOGGLE",
  QUICK_SAVE: "QUICK_SAVE",
  QUICK_LOAD: "QUICK_LOAD",
  MENU: "MENU",
  PAUSE: "PAUSE",
});

export const ACTION_LIST = Object.freeze(Object.values(ACTIONS));

// All nine 8-way move actions (N/S/E/W plus the four diagonals).
export const MOVE_ACTIONS = Object.freeze([
  ACTIONS.MOVE_NORTH,
  ACTIONS.MOVE_NORTH_EAST,
  ACTIONS.MOVE_EAST,
  ACTIONS.MOVE_SOUTH_EAST,
  ACTIONS.MOVE_SOUTH,
  ACTIONS.MOVE_SOUTH_WEST,
  ACTIONS.MOVE_WEST,
  ACTIONS.MOVE_NORTH_WEST,
]);

export const CATEGORY = Object.freeze({
  movement: "movement",
  locomotion: "locomotion",
  combat: "combat",
  interaction: "interaction",
  system: "system",
});

export const ACTION_META = Object.freeze({
  MOVE_NORTH: { category: CATEGORY.movement, dx: 0, dy: -1 },
  MOVE_SOUTH: { category: CATEGORY.movement, dx: 0, dy: 1 },
  MOVE_EAST: { category: CATEGORY.movement, dx: 1, dy: 0 },
  MOVE_WEST: { category: CATEGORY.movement, dx: -1, dy: 0 },
  MOVE_NORTH_EAST: { category: CATEGORY.movement, dx: 1, dy: -1 },
  MOVE_NORTH_WEST: { category: CATEGORY.movement, dx: -1, dy: -1 },
  MOVE_SOUTH_EAST: { category: CATEGORY.movement, dx: 1, dy: 1 },
  MOVE_SOUTH_WEST: { category: CATEGORY.movement, dx: -1, dy: 1 },
  RUN: { category: CATEGORY.locomotion, modifier: true },
  JUMP: { category: CATEGORY.locomotion },
  CLIMB: { category: CATEGORY.locomotion },
  ATTACK: { category: CATEGORY.combat },
  KICK: { category: CATEGORY.combat },
  BLOCK: { category: CATEGORY.combat, held: true },
  USE: { category: CATEGORY.interaction },
  PICK_UP: { category: CATEGORY.interaction },
  INVENTORY: { category: CATEGORY.system, toggle: true },
  COMBAT_TOGGLE: { category: CATEGORY.combat, toggle: true },
  QUICK_SAVE: { category: CATEGORY.system },
  QUICK_LOAD: { category: CATEGORY.system },
  MENU: { category: CATEGORY.system, toggle: true },
  PAUSE: { category: CATEGORY.system, toggle: true },
});

export function isAction(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ACTIONS, value);
}

export function isMoveAction(value) {
  return MOVE_ACTIONS.includes(value);
}

export function meta(action) {
  if (!isAction(action)) throw new Error(`unknown action: ${action}`);
  return ACTION_META[action];
}

export function moveVector(action) {
  if (!isMoveAction(action)) return null;
  const m = ACTION_META[action];
  return { dx: m.dx, dy: m.dy };
}
