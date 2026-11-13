// shell/ui/touch.js
// Landscape touch controls: a virtual 8-way stick and round action buttons,
// built for iOS Safari and Android Chrome. Uses native Touch Events as the
// primary path (reliable on real devices and under CDP touch emulation) and
// Pointer Events for mouse/pen only, so a gesture is never handled twice.
// Pure resolution helpers are exported for Node tests; DOM mounting is not.
import { mapTouch, quantizeStick } from "../core/inputmap.js";
import { el } from "./dom.js";

// Button ids match core/inputmap.js modern & classic touch tables.
export const TOUCH_BUTTONS = Object.freeze([
  { id: "buttonA", label: "Attack", glyph: "⚔" },
  { id: "buttonB", label: "Jump", glyph: "▲" },
  { id: "buttonC", label: "Use", glyph: "✥" },
  { id: "buttonD", label: "Block", glyph: "◈" },
  { id: "buttonInv", label: "Items", glyph: "▤" },
  { id: "buttonRun", label: "Run", glyph: "»" },
  { id: "buttonMenu", label: "Menu", glyph: "☰" },
]);

export const STICK_RADIUS = 56;      // px travel for a full-deflection push
export const STICK_DEADZONE = 0.25;

export function buttonAction(bindings, id) {
  return mapTouch(bindings, { kind: "button", id, phase: "tap" });
}

export function stickAction(x, y) {
  return quantizeStick(x, y, STICK_DEADZONE);
}

function clampVector(dx, dy) {
  const mag = Math.hypot(dx, dy);
  if (mag <= STICK_RADIUS || mag === 0) return { x: dx / STICK_RADIUS, y: dy / STICK_RADIUS };
  return { x: dx / mag, y: dy / mag };
}

// Mount the touch layer into `root`. Calls onAction(action, {down}) for every
// resolved abstract action; callers forward those through the game bridge.
export function mountTouchControls(root, options = {}) {
  const getBindings = options.getBindings ?? (() => ({}));
  const onAction = options.onAction ?? (() => {});
  const pressed = new Map();       // touch id -> action (buttons)
  let stickTouchId = null;
  let lastStickAction = null;

  const knob = el("div", { class: "stick-knob", "aria-hidden": "true" });
  const stick = el("div", { class: "stick", id: "u8-stick", role: "group", "aria-label": "Movement stick" }, knob);
  const buttons = TOUCH_BUTTONS.map((b) => el("button", {
    class: `pad-btn pad-${b.id}`,
    id: `u8-${b.id}`,
    type: "button",
    "data-action-id": b.id,
    "aria-label": b.label,
  }, el("span", { class: "pad-glyph", text: b.glyph })));
  const pad = el("div", { class: "pad", id: "u8-pad" }, ...buttons);

  const emit = (action, down) => { if (action) onAction(action, { down }); };

  function releaseStick() {
    stickTouchId = null;
    knob.style.transform = "translate(0px, 0px)";
    if (lastStickAction) emit(lastStickAction, false);
    lastStickAction = null;
  }

  function moveStick(clientX, clientY) {
    const r = stick.getBoundingClientRect();
    const raw = clampVector(clientX - (r.left + r.width / 2), clientY - (r.top + r.height / 2));
    const len = Math.hypot(raw.x, raw.y);
    const scaled = len > 1 ? { x: raw.x / len, y: raw.y / len } : raw;
    knob.style.transform = `translate(${scaled.x * STICK_RADIUS}px, ${scaled.y * STICK_RADIUS}px)`;
    const action = stickAction(raw.x, raw.y);
    if (action !== lastStickAction) {
      if (lastStickAction) emit(lastStickAction, false);
      if (action) emit(action, true);
      lastStickAction = action;
    }
  }

  // Returns the first changed touch for a gesture start, else null.
  const startTouch = (ev, id) => {
    const t = ev.changedTouches?.[0];
    if (!t) return null;
    if (id === "stick") stickTouchId = t.identifier;
    return t;
  };

  // --- Stick: native touch + pointer(mouse/pen) ----------------------------
  const stickMove = (ev) => {
    for (const t of ev.changedTouches ?? []) if (t.identifier === stickTouchId) moveStick(t.clientX, t.clientY);
    ev.preventDefault();
  };
  const stickEnd = (ev) => {
    for (const t of ev.changedTouches ?? []) if (t.identifier === stickTouchId) releaseStick();
    ev.preventDefault();
  };
  stick.addEventListener("touchstart", (ev) => { const t = startTouch(ev, "stick"); if (t) moveStick(t.clientX, t.clientY); ev.preventDefault(); }, { passive: false });
  stick.addEventListener("touchmove", stickMove, { passive: false });
  stick.addEventListener("touchend", stickEnd, { passive: false });
  stick.addEventListener("touchcancel", stickEnd, { passive: false });

  stick.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "touch") return; // touch events already cover this
    stickTouchId = "mouse";
    stick.setPointerCapture?.(ev.pointerId);
    moveStick(ev.clientX, ev.clientY);
    ev.preventDefault();
  });
  stick.addEventListener("pointermove", (ev) => { if (ev.pointerType !== "touch" && stickTouchId === "mouse") moveStick(ev.clientX, ev.clientY); });
  const stickPointerEnd = (ev) => { if (ev.pointerType !== "touch" && stickTouchId === "mouse") releaseStick(); };
  stick.addEventListener("pointerup", stickPointerEnd);
  stick.addEventListener("pointercancel", stickPointerEnd);

  // --- Buttons -------------------------------------------------------------
  for (const node of pad.querySelectorAll(".pad-btn")) {
    const id = node.getAttribute("data-action-id");
    const press = (action, down) => emit(action, down);
    node.addEventListener("touchstart", (ev) => {
      const t = ev.changedTouches?.[0];
      if (!t) return;
      const action = buttonAction(getBindings(), id);
      pressed.set(t.identifier, action);
      press(action, true);
      ev.preventDefault();
    }, { passive: false });
    const touchEnd = (ev) => {
      for (const t of ev.changedTouches ?? []) {
        if (pressed.has(t.identifier)) { press(pressed.get(t.identifier), false); pressed.delete(t.identifier); }
      }
      ev.preventDefault();
    };
    node.addEventListener("touchend", touchEnd, { passive: false });
    node.addEventListener("touchcancel", touchEnd, { passive: false });

    node.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType === "touch") return;
      node.setPointerCapture?.(ev.pointerId);
      const action = buttonAction(getBindings(), id);
      pressed.set(`p${ev.pointerId}`, action);
      press(action, true);
      ev.preventDefault();
    });
    const pointerEnd = (ev) => {
      if (ev.pointerType === "touch") return;
      const key = `p${ev.pointerId}`;
      if (pressed.has(key)) { press(pressed.get(key), false); pressed.delete(key); }
    };
    node.addEventListener("pointerup", pointerEnd);
    node.addEventListener("pointercancel", pointerEnd);
    node.addEventListener("pointerleave", pointerEnd);
  }

  root.append(stick, pad);
  return { stick, pad, releaseStick, buttonIds: TOUCH_BUTTONS.map((b) => b.id) };
}
