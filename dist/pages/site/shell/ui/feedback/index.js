// shell/ui/feedback/index.js
// Binds engine combat events to presentation. This is the ONLY consumer of
// `bridge.onCombat`; it never listens to DOM input, so feedback always reflects
// a real engine hit/block/hurt/death and never a button press.
import { normalizeCombatEvent, effectsFor, statusText } from "./events.js";
import { createEffectsLayer } from "./effects.js";
import { createHaptics } from "./haptics.js";

export { normalizeCombatEvent, effectsFor, statusText } from "./events.js";
export { createHaptics } from "./haptics.js";
export { createEffectsLayer } from "./effects.js";

// Apply one already-normalized event to the layer + haptics. Pure-ish (touches
// only the injected layer/haptics), so it is safe to unit test with fakes.
export function present(layer, haptics, event, opts = {}) {
  if (!event) return [];
  const fx = effectsFor(event, opts);
  for (const effect of fx) {
    if (effect.type === "flash") layer.flash?.(effect.tone, effect.ms);
    else if (effect.type === "shake") layer.shake?.(effect.magnitude);
    else if (effect.type === "damage-number") layer.number?.(effect.amount, effect.tone, effect.critical);
    else if (effect.type === "haptic") haptics?.vibrate?.(effect.pattern);
  }
  return fx;
}

// Mount onto a viewport element. Returns a handle the app wires to
// `bridge.onCombat`. `enabled` mirrors the Modern/Classic assist setting; when
// disabled, engine events still arrive but nothing is played.
export function mountFeedback(viewport, options = {}) {
  const layer = options.layer ?? createEffectsLayer(viewport, options);
  const haptics = options.haptics ?? createHaptics(options);
  let enabled = options.enabled !== false;
  const onStatus = typeof options.onStatus === "function" ? options.onStatus : null;

  function handle(messageOrEvent) {
    const event = normalizeCombatEvent(messageOrEvent);
    if (!event) return null;
    const text = statusText(event);
    if (onStatus) { try { onStatus(event, text); } catch { /* status is cosmetic */ } }
    if (!enabled) return event;
    present(layer, haptics, event, options);
    return event;
  }

  return {
    handle,
    layer,
    haptics,
    isEnabled: () => enabled,
    setEnabled(value) { enabled = Boolean(value); return enabled; },
    dispose() { layer.clear?.(); },
  };
}
