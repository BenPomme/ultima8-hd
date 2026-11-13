// shell/ui/feedback/events.js
// Pure parsing of engine-originated combat messages into a normalized event,
// plus the intent->effect map the presentation layer plays. No DOM, no window:
// this file runs unchanged under Node so the mapping is unit-tested directly.
//
// Feedback is driven ONLY by engine events delivered through
// `bridge.onCombat`. Nothing here reacts to a button press, and an unknown or
// malformed event produces no effect (never a synthesized guess).

// The four player-visible outcomes the engine can report. Anything else is
// dropped rather than mapped onto a nearest neighbour.
export const COMBAT_KIND = Object.freeze({ HIT: "hit", BLOCK: "block", HURT: "hurt", DEATH: "death" });

const KIND_ALIASES = Object.freeze({
  hit: "hit", damage: "hit", hitdispatch: "hit", "hit-dispatch": "hit",
  block: "block", blocked: "block", "block-reduction": "block",
  hurt: "hurt", receivehit: "hurt", "receivehit-u8": "hurt", taken: "hurt",
  death: "death", die: "death", "death-branch": "death", "avatar-death": "death", "die-u8": "death",
});

function str(v) { return v === undefined || v === null ? null : String(v); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function bool(v) { return v === true; }

// Accept the wire `{ type:"combat", event:{...} }`, a bare `{ ...event }`, or an
// already-normalized event. Returns null when there is no usable `kind`.
export function normalizeCombatEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const src = raw.event && typeof raw.event === "object" ? raw.event : raw;
  const rawKind = str(src.kind ?? src.type ?? src.name ?? src.hook);
  if (!rawKind) return null;
  const key = rawKind.toLowerCase().replace(/\s+/g, "");
  const kind = KIND_ALIASES[key];
  if (!kind) return null;
  const actor = str(src.actor ?? src.attacker ?? src.source?.["id"] ?? src.source);
  const target = str(src.target ?? src.victim ?? src.receiver ?? src.victim?.["id"]);
  return {
    kind,
    actor,
    target,
    damage: num(src.damage ?? src.amount ?? src.amt),
    hp: num(src.hp ?? src.health),
    maxHp: num(src.maxHp ?? src.max_hp ?? src.maxhp),
    critical: bool(src.critical ?? src.crit),
    byPlayer: bool(src.byPlayer ?? src.by_player ?? src.fromPlayer),
    x: num(src.x),
    y: num(src.y),
  };
}

// Severity buckets keep shake/haptic values readable and testable, and bound the
// effect so a 999-damage reading cannot fling the viewport off screen.
export function severityOf(e) {
  const dmg = e.damage ?? 0;
  if (e.kind === COMBAT_KIND.DEATH) return 4;
  if (e.kind === COMBAT_KIND.BLOCK) return 1;
  if (dmg >= 30) return 3;
  if (dmg >= 12) return 2;
  if (dmg > 0) return 1;
  return e.kind === COMBAT_KIND.HURT ? 2 : 1;
}

// Normalized event -> ordered list of presentation effects. `opts.frame` is the
// number of frames (viewport-relative) the effect should run for; the DOM layer
// scales it by the CSS variable. Kept pure and deterministic.
export function effectsFor(event, opts = {}) {
  if (!event) return [];
  const s = severityOf(event);
  const fx = [];
  if (event.kind === COMBAT_KIND.BLOCK) {
    fx.push({ type: "flash", tone: "block", ms: 180 });
    fx.push({ type: "shake", magnitude: 4 });
    fx.push({ type: "haptic", pattern: [10] });
    return fx;
  }
  if (event.kind === COMBAT_KIND.DEATH) {
    fx.push({ type: "shake", magnitude: 16 });
    fx.push({ type: "flash", tone: event.byPlayer ? "death" : "ko", ms: 320 });
    if (!event.byPlayer) fx.push({ type: "damage-number", amount: null, tone: "death", critical: false });
    fx.push({ type: "haptic", pattern: [60, 40, 90] });
    return fx;
  }
  // hit / hurt share the shape; tone and haptic weight differ.
  const tone = event.kind === COMBAT_KIND.HURT ? "hurt" : (event.critical ? "crit" : "hit");
  fx.push({ type: "shake", magnitude: Math.min(16, 4 + s * 4) });
  fx.push({ type: "flash", tone, ms: event.kind === COMBAT_KIND.HURT ? 260 : 140 });
  if (event.damage !== null && event.damage > 0) {
    fx.push({ type: "damage-number", amount: event.damage, tone, critical: event.critical });
  }
  fx.push({ type: "haptic", pattern: hapticPatternFor(event) });
  return fx;
}

export function hapticPatternFor(event) {
  const s = severityOf(event);
  if (event.kind === COMBAT_KIND.HURT) return s >= 3 ? [50, 40, 50] : [35];
  if (event.kind === COMBAT_KIND.HIT) return event.critical ? [30, 20, 30] : [20];
  return null; // block/death handled in effectsFor
}

// One-line status text for the HUD, or null. Never invents a value the engine
// did not send (e.g. no damage number when the event carried no damage).
export function statusText(event) {
  if (!event) return null;
  if (event.kind === COMBAT_KIND.HURT) return event.damage ? `−${event.damage} HP` : "Hurt";
  if (event.kind === COMBAT_KIND.HIT) return event.damage ? `${event.damage} dmg` : "Hit";
  if (event.kind === COMBAT_KIND.BLOCK) return "Blocked";
  if (event.kind === COMBAT_KIND.DEATH) return event.byPlayer ? "You died" : "Foe down";
  return null;
}
