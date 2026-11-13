// shell/ui/feedback/effects.js
// DOM presentation for a single combat beat: a short camera shake, a colour
// flash, and a floating damage number. The numeric inputs are clamped here so a
// malformed engine value can never fling the stage or overflow the HUD. Node
// tests exercise the pure helpers; mounting needs a document.
export const MAX_SHAKE = 16;

export function clampMagnitude(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_SHAKE, n));
}

// Deterministic per-step offsets for a shake of the given magnitude. Screen
// space only; callers animate by cycling these.
export function shakeFrames(magnitude, steps = 4) {
  const m = clampMagnitude(magnitude);
  const seq = [];
  for (let i = 0; i < steps; i += 1) {
    const sign = i % 2 === 0 ? 1 : -1;
    const scale = (steps - i) / steps;
    seq.push({ x: Number((sign * m * scale).toFixed(2)), y: Number((sign * m * scale * 0.5).toFixed(2)) });
  }
  return seq;
}

export function prefersReducedMotion(win) {
  try { return Boolean(win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches); } catch { return false; }
}

// Build the three overlay nodes inside `host` (the viewport element).
export function createEffectsLayer(host, options = {}) {
  const doc = options.doc ?? host?.ownerDocument ?? (typeof document !== "undefined" ? document : null);
  if (!host || !doc) return { flash() {}, shake() {}, number() {}, clear() {} };
  const reduce = options.reducedMotion ?? prefersReducedMotion(doc.defaultView);
  // The overlay (flash + numbers) lives on `host`; the shake is applied to a
  // separate element so a re-rendered viewport never loses the overlay.
  const shakeTarget = options.shakeTarget ?? host;

  const flashEl = doc.createElement("div");
  flashEl.className = "u8-flash";
  const numEl = doc.createElement("div");
  numEl.className = "u8-numbers";
  host.append(flashEl, numEl);

  const timers = new Set();
  function after(ms, fn) { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; }

  function flash(tone, ms) {
    flashEl.dataset.tone = tone ?? "hit";
    flashEl.classList.add("on");
    after(reduce ? 0 : (ms ?? 160), () => flashEl.classList.remove("on"));
  }

  function shake(magnitude) {
    if (reduce) return;
    const m = clampMagnitude(magnitude);
    if (!(m > 0)) return;
    shakeTarget.style.setProperty("--u8-shake", `${m}px`);
    shakeTarget.classList.remove("u8-shake");
    // force reflow so the animation restarts on back-to-back hits
    void shakeTarget.offsetWidth;
    shakeTarget.classList.add("u8-shake");
    after(180, () => { shakeTarget.classList.remove("u8-shake"); shakeTarget.style.removeProperty("--u8-shake"); });
  }

  function number(amount, tone, critical) {
    const node = doc.createElement("span");
    node.className = "u8-dmg";
    node.dataset.tone = tone ?? "hit";
    if (critical) node.dataset.crit = "1";
    node.textContent = amount === null || amount === undefined ? "✕" : String(Math.round(amount));
    node.style.setProperty("--u8-dmg-x", `${(Math.random() * 40 - 20).toFixed(0)}px`);
    numEl.append(node);
    after(900, () => node.remove());
  }

  function clear() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    flashEl.classList.remove("on");
    shakeTarget.classList.remove("u8-shake");
    numEl.replaceChildren?.();
  }

  return { flash, shake, number, clear, elements: { flashEl, numEl } };
}
