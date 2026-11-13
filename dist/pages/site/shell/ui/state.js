// shell/ui/state.js
// Pure UI state for the game shell: screen flow, settings draft, control
// bindings and the decisions the DOM layer asks for. No DOM, no window, no
// storage, so it runs unchanged under Node for tests.
import { validate, defaultSettings } from "../core/settings.js";
import { defaultBindings, getBindings, mapKey, rebind } from "../core/inputmap.js";

export const SCREEN = Object.freeze({
  TITLE: "title",
  NAME: "name",
  LOADING: "loading",
  PLAY: "play",
  PAUSE: "pause",
  SETTINGS: "settings",
  REBIND: "rebind",
});

export const MAX_NAME = 16;
export const DEFAULT_NAME = "Avatar";

export function sanitizeName(raw) {
  const text = String(raw ?? "").replace(/[\u0000-\u001f]+/g, "").replace(/ {2,}/g, " ");
  return text.trimStart().slice(0, MAX_NAME);
}

export function createUiState(overrides = {}) {
  const settings = validate({ ...defaultSettings(), ...overrides }).settings;
  return {
    screen: SCREEN.TITLE,
    playerName: "",
    nameDraft: "",
    settings,
    bindings: defaultBindings(),
    rebind: null,
    message: "",
    // N2: an early Skip pressed while the engine/bridge is not ready yet. It is
    // honoured exactly once, by the ready path, instead of entering PLAY over an
    // engine that never received the skip.
    pendingSkip: false,
    // N2: true only after the shell has actually reached gameplay once (a
    // successful Begin or the ready-path skip transition). The HUD/NPC lock is
    // released by this flag, never by the PLAY screen alone.
    worldEntered: false,
  };
}

// N2: mark the moment the shell really entered gameplay. The HUD/NPC safety
// gate keys off this, so a PLAY screen raised before the world exists (or
// during the opening STASIS 1 dialogue) never shows them.
export function markWorldEntered(state) {
  return state.worldEntered ? state : { ...state, worldEntered: true };
}

// N2: record that a Skip was requested before the bridge/engine was ready.
export function requestPendingSkip(state) {
  return state.pendingSkip ? state : { ...state, pendingSkip: true };
}

// N2: consume the pending Skip (exactly once).
export function clearPendingSkip(state) {
  return state.pendingSkip ? { ...state, pendingSkip: false } : state;
}

// N2: the single decision the safety gate asks. The HUD and the NPC panel are
// hidden whenever the screen is not PLAY, or when PLAY is up but no game world
// has been entered yet. After `worldEntered` they are NEVER hidden, including
// during STASIS 1 dialogue.
export function introLocked(state) {
  if (state.screen !== SCREEN.PLAY) return true;
  return state.worldEntered !== true;
}

export function navigate(state, screen) {
  return { ...state, screen, message: "" };
}

export function setPlayerName(state, value) {
  return { ...state, nameDraft: sanitizeName(value) };
}

export function commitPlayerName(state) {
  const name = sanitizeName(state.nameDraft).trim() || DEFAULT_NAME;
  return { ...state, playerName: name, nameDraft: name };
}

export function setMode(state, mode) {
  const res = validate({ ...state.settings, mode });
  return { ...state, settings: res.settings, message: "" };
}

export function setSetting(state, key, value) {
  const res = validate({ ...state.settings, [key]: value });
  if (!res.ok) return { ...state, message: res.errors.join("; ") };
  return { ...state, settings: res.settings, message: "" };
}

export function currentBindings(state) {
  return state.bindings[state.settings.mode] ?? getBindings(state.settings.mode);
}

export function isPassthroughMode(state) {
  return currentBindings(state).passthrough === true;
}

// The single travel-speed multiplier the shell asks the engine for. Classic
// keeps the engine's own 1x (its enhancements are forced off); Modern uses the
// Game speed slider, doubled while Fast travel is on, capped at the slider's
// own maximum so the shell never asks beyond the range it exposes.
export function engineSpeed(settings) {
  if (!settings || settings.mode === "classic") return 1;
  const base = Number(settings.gameSpeed) || 1;
  return Math.min(4, base * (settings.fastTravel ? 2 : 1));
}

export function beginRebind(state, device, action) {
  return { ...state, screen: SCREEN.REBIND, rebind: { device, action }, message: "" };
}

export function cancelRebind(state) {
  return { ...state, screen: SCREEN.SETTINGS, rebind: null, message: "" };
}

export function captureRebind(state, code) {
  const pending = state.rebind;
  if (!pending) return { state: cancelRebind(state), ok: false, conflict: "no pending rebind" };
  const res = rebind(currentBindings(state), {
    device: pending.device,
    code,
    action: pending.action,
  });
  if (!res.ok) {
    return {
      state: { ...state, message: `Already used by ${res.conflict}. Try another.` },
      ok: false,
      conflict: res.conflict,
    };
  }
  const mode = state.settings.mode;
  const bindings = { ...state.bindings, [mode]: res.bindings };
  return {
    state: { ...state, bindings, screen: SCREEN.SETTINGS, rebind: null, message: `Bound ${code}.` },
    ok: true,
    conflict: null,
  };
}

// Decide what a raw keyboard event means for the current screen.
// Returns {kind:'rebind-capture'|'passthrough'|'action'|'ignore', ...}.
export function keyToCommand(state, code, phase) {
  if (state.screen === SCREEN.REBIND) {
    return phase === "down" && state.rebind ? { kind: "rebind-capture", code } : { kind: "ignore" };
  }
  if (state.screen !== SCREEN.PLAY) return { kind: "ignore" };
  const bindings = currentBindings(state);
  if (bindings.passthrough) return { kind: "passthrough", code, down: phase === "down" };
  const action = mapKey(bindings, code);
  if (!action) return { kind: "ignore" };
  return { kind: "action", action, down: phase === "down" };
}

// Summarise the live HUD. `engine` (optional) carries only values the engine
// itself published (name, hp, maxHp); nothing is invented. When the engine has
// not reported a value the field is left blank/hidden rather than dashed, so the
// HUD never shows a made-up game fact.
export function hudModel(state, engine = null) {
  const classic = state.settings.mode === "classic";
  const hp = Number(engine?.hp);
  const maxHp = Number(engine?.maxHp);
  const hasHealth = Number.isFinite(hp) && Number.isFinite(maxHp) && maxHp > 0;
  const engineName = typeof engine?.name === "string" ? engine.name.trim() : "";
  return {
    name: engineName || state.playerName || "",
    modeLabel: classic ? "Classic" : "Modern",
    passthrough: isPassthroughMode(state),
    speed: state.settings.gameSpeed,
    health: hasHealth ? `${hp}/${maxHp}` : "",
    hasHealth,
    // No source-backed place name exists in the contract, so Place is hidden.
    location: null,
    hasPlace: false,
  };
}
