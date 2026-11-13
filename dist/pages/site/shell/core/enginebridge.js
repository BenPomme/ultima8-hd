// shell/core/enginebridge.js
// Interface-only bridge: translates abstract actions into a flat list of
// synthetic engine events, pushed to an injectable sink. No engine internals,
// no Emscripten calls, no DOM/window/fetch. Event shape:
//   { type: "key" | "button" | "pointer", key?, button?, x?, y?, down }
import { ACTIONS, isAction, isMoveAction, moveVector } from "./actions.js";

const A = ACTIONS;

// Static action -> event templates. Movement is expressed as key events; the
// optional `pointer` flag lets a caller emit pointer coordinates instead.
export const DEFAULT_EVENT_MAP = Object.freeze({
  [A.MOVE_NORTH]: { type: "key", key: "move north" },
  [A.MOVE_SOUTH]: { type: "key", key: "move south" },
  [A.MOVE_EAST]: { type: "key", key: "move east" },
  [A.MOVE_WEST]: { type: "key", key: "move west" },
  [A.MOVE_NORTH_EAST]: { type: "key", key: "move north east" },
  [A.MOVE_NORTH_WEST]: { type: "key", key: "move north west" },
  [A.MOVE_SOUTH_EAST]: { type: "key", key: "move south east" },
  [A.MOVE_SOUTH_WEST]: { type: "key", key: "move south west" },
  [A.RUN]: { type: "key", key: "run" },
  [A.JUMP]: { type: "key", key: "jump" },
  [A.CLIMB]: { type: "key", key: "climb" },
  [A.ATTACK]: { type: "button", button: "attack" },
  [A.KICK]: { type: "button", button: "kick" },
  [A.BLOCK]: { type: "button", button: "block" },
  [A.USE]: { type: "button", button: "use" },
  [A.PICK_UP]: { type: "button", button: "pickup" },
  [A.INVENTORY]: { type: "button", button: "inventory" },
  [A.COMBAT_TOGGLE]: { type: "button", button: "combat toggle" },
  [A.QUICK_SAVE]: { type: "key", key: "quick save" },
  [A.QUICK_LOAD]: { type: "key", key: "quick load" },
  [A.MENU]: { type: "key", key: "menu" },
  [A.PAUSE]: { type: "key", key: "pause" },
});

// Actions whose default event is a held (on-then-off) press.
const HELD_ACTIONS = Object.freeze(new Set([A.BLOCK, A.RUN]));

function noop() {}

// Pure translation: action (+ context) -> array of events. Never mutates input.
export function actionToEvents(action, context = {}) {
  if (!isAction(action)) return [];
  const template = context.eventMap?.[action] ?? DEFAULT_EVENT_MAP[action];
  if (!template) return [];
  const down = context.down !== undefined ? Boolean(context.down) : true;
  const base = { down };
  if (template.key !== undefined) base.key = template.key;
  if (template.button !== undefined) base.button = template.button;
  base.type = template.type;
  const events = [base];
  if (HELD_ACTIONS.has(action) && context.release === true) {
    events.push({ ...base, down: false });
  }
  // Pointer-mode movement carries coordinates when the caller supplies them.
  if (isMoveAction(action) && context.pointer === true) {
    const v = moveVector(action);
    events[0].type = "pointer";
    delete events[0].key;
    events[0].x = (Number(context.x) || 0) + (v ? v.dx : 0);
    events[0].y = (Number(context.y) || 0) + (v ? v.dy : 0);
  }
  return events;
}

// Collapse a list of actions into a single flat event stream.
export function actionsToEvents(actions, context = {}) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  for (const action of actions) out.push(...actionToEvents(action, context));
  return out;
}

// The bridge object. `sink` is any callable(eventsSummary, events) you inject;
// the bridge itself never talks to an engine.
export function createEngineBridge(options = {}) {
  const sink = typeof options.sink === "function" ? options.sink : noop;
  const eventMap = options.eventMap ?? DEFAULT_EVENT_MAP;
  const log = [];

  function translate(action, context = {}) {
    return actionToEvents(action, { ...context, eventMap });
  }

  function dispatch(action, context = {}) {
    const events = translate(action, context);
    if (events.length === 0) return events;
    const summary = { action, count: events.length };
    log.push(summary);
    sink(summary, events);
    return events;
  }

  function dispatchAll(actions, context = {}) {
    const events = [];
    for (const action of actions) events.push(...dispatch(action, context));
    return events;
  }

  return {
    translate,
    dispatch,
    dispatchAll,
    getLog: () => log.map((entry) => ({ ...entry })),
    clearLog: () => { log.length = 0; },
  };
}

export function synthesizeEvents(actions, context = {}) {
  return actionsToEvents(actions, context);
}
