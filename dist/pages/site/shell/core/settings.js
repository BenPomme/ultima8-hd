// shell/core/settings.js
// Headless settings schema: defaults, validation, migration, (de)serialization.
// Pure ES module. No DOM, no window, no fetch, no sockets.

export const SCHEMA_VERSION = 1;

const LANGUAGE_VALUES = ["en", "fr", "de"];
const MODE_VALUES = ["modern", "classic"];
const TOUCH_LAYOUT_VALUES = ["auto", "dpad", "stick", "classic"];
const ORIENTATION_VALUES = ["landscape"];
const MUSIC_SOURCE_VALUES = ["fm", "gm"];
const ART_MODE_VALUES = ["classic", "hd2", "hd4"];

// `enhancement: true` marks settings that are modern-only and disabled in
// Classic mode; `offValue` is what Classic forces them to.
export const SCHEMA = Object.freeze({
  mode: { type: "enum", values: MODE_VALUES, default: "modern" },
  language: { type: "enum", values: LANGUAGE_VALUES, default: "en" },
  gameSpeed: { type: "number", default: 1, min: 0.25, max: 4, step: 0.25, enhancement: true, offValue: 1 },
  combatAssist: { type: "boolean", default: true, enhancement: true, offValue: false },
  fastTravel: { type: "boolean", default: true, enhancement: true, offValue: false },
  musicVolume: { type: "number", default: 0.7, min: 0, max: 1, step: 0.05 },
  sfxVolume: { type: "number", default: 0.8, min: 0, max: 1, step: 0.05 },
  alwaysRun: { type: "boolean", default: false, enhancement: true, offValue: false },
  // [W3 click-move] Modern input enhancement: a single left click on the world
  // walks there through the engine's own pathfinder WHEN the running build
  // publishes the path block. Default OFF (W3c decision): the feature stays
  // inert until a path-capable build and an explicit opt-in. Touch keeps the
  // stick primary (the click path forces it off on touch) and Classic forces it
  // off via the enhancement off-value.
  clickToMove: { type: "boolean", default: true, enhancement: true, offValue: false },
  touchLayout: { type: "enum", values: TOUCH_LAYOUT_VALUES, default: "stick" },
  // Music source: "fm" is the original AdLib/Miles FM score (the honest
  // default, always available). "gm" plays the SAME original score through
  // General MIDI instruments once a SoundFont is staged — a better
  // performance of the original tracks, never a different score. Classic
  // forces FM (offValue), Modern restores the stored choice.
  musicSource: { type: "enum", values: MUSIC_SOURCE_VALUES, default: "fm", enhancement: true, offValue: "fm" },
  // CP61 art mode: visual scale. Desktop default hd2, mobile/touch default
  // classic. hd4 experimental on desktop only. Not a mode enhancement (Classic
  // game mode allows HD art), but the shell applies mobile/touch policies.
  artMode: { type: "enum", values: ART_MODE_VALUES, default: "hd2" },
  orientation: { type: "enum", values: ORIENTATION_VALUES, default: "landscape", locked: true },
});

export const SETTINGS_KEYS = Object.freeze(Object.keys(SCHEMA));

export const ENHANCEMENT_KEYS = Object.freeze(
  SETTINGS_KEYS.filter((k) => SCHEMA[k].enhancement === true),
);

export function defaultSettings(isMobile = false) {
  const out = {};
  for (const key of SETTINGS_KEYS) {
    if (key === "artMode") {
      out[key] = isMobile ? "classic" : "hd2";
    } else {
      out[key] = SCHEMA[key].default;
    }
  }
  return out;
}

// Legacy (pre-versioned) key names -> current schema keys.
const LEGACY_KEY_MAP = Object.freeze({
  music: "musicVolume",
  sound: "sfxVolume",
  sfx: "sfxVolume",
  speed: "gameSpeed",
  controls: "touchLayout",
  language_code: "language",
});

function checkField(key, value, spec) {
  if (spec.type === "boolean") {
    if (typeof value !== "boolean") return `${key} must be a boolean`;
    return null;
  }
  if (spec.type === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) return `${key} must be a number`;
    if (!Number.isFinite(value)) return `${key} must be finite`;
    if (value < spec.min || value > spec.max) return `${key} must be within [${spec.min}, ${spec.max}]`;
    return null;
  }
  if (spec.type === "enum") {
    if (!spec.values.includes(value)) return `${key} must be one of ${spec.values.join(", ")}`;
    return null;
  }
  return `${key} has unknown schema type`;
}

// Coerce loose input into schema types where unambiguous; returns {value, error}.
function coerceField(key, spec, value) {
  if (value === undefined) return { value: spec.default };
  if (spec.type === "boolean" && typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "1", "on", "yes"].includes(v)) value = true;
    else if (["false", "0", "off", "no"].includes(v)) value = false;
  }
  if (spec.type === "number" && typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (!Number.isNaN(n)) value = n;
  }
  if (spec.type === "enum" && typeof value === "string") value = value.trim().toLowerCase();
  return { value };
}

export function validate(input) {
  const errors = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["settings must be a plain object"], settings: defaultSettings() };
  }
  for (const key of Object.keys(input)) {
    if (!SETTINGS_KEYS.includes(key)) errors.push(`unknown setting: ${key}`);
  }
  const out = defaultSettings();
  for (const key of SETTINGS_KEYS) {
    const spec = SCHEMA[key];
    const { value } = coerceField(key, spec, input[key]);
    const err = checkField(key, value, spec);
    if (err) errors.push(err);
    else out[key] = value;
  }
  if (errors.length > 0) return { ok: false, errors, settings: out };
  // NOTE: the user's Modern enhancement choices are preserved verbatim even in
  // Classic. Classic's off-values are a DERIVED view (effectiveSettings), never a
  // mutation of storage, so toggling Classic -> Modern restores the real prefs
  // instead of showing rate 100 / multiplier 1x.
  return { ok: true, errors: [], settings: out };
}

// Classic mode forces every modern enhancement to its off value. This is a pure
// DISPLAY/engine view: applying it never writes back to the stored profile.
export function applyModePolicy(settings) {
  const out = { ...settings };
  if (out.mode === "classic") {
    for (const key of ENHANCEMENT_KEYS) out[key] = SCHEMA[key].offValue;
  }
  return out;
}

export const CLASSIC_OVERRIDES = Object.freeze(
  Object.fromEntries(ENHANCEMENT_KEYS.map((k) => [k, SCHEMA[k].offValue])),
);

// The settings the engine/UI should ACT on right now: Classic forces the
// modern enhancements to their off values; Modern uses the stored profile.
// Storage keeps the untouched Modern profile so a Classic toggle is reversible.
export function effectiveSettings(settings) {
  if (!settings || settings.mode !== "classic") return { ...settings };
  const out = applyModePolicy(settings);
  return validate({ ...out, mode: "classic" }).settings;
}

export function migrate(raw) {
  const errors = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["migrate input must be a plain object"], settings: defaultSettings(), from: null };
  }
  const from = typeof raw.version === "number" ? raw.version : 0;
  if (from > SCHEMA_VERSION) {
    return { ok: false, errors: [`unsupported settings version ${from} > ${SCHEMA_VERSION}`], settings: defaultSettings(), from };
  }
  const working = { ...raw };
  delete working.version;
  for (const [oldKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
    if (oldKey in working && !(newKey in working)) working[newKey] = working[oldKey];
    delete working[oldKey];
  }
  const res = validate(working);
  if (!res.ok) errors.push(...res.errors);
  return { ok: errors.length === 0, errors, settings: res.settings, from };
}

export function serialize(settings) {
  const res = validate(settings);
  if (!res.ok) throw new Error(`cannot serialize invalid settings: ${res.errors.join("; ")}`);
  const ordered = { version: SCHEMA_VERSION };
  for (const key of SETTINGS_KEYS) ordered[key] = res.settings[key];
  return JSON.stringify(ordered);
}

export function deserialize(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, errors: ["serialized settings must be a non-empty string"], settings: defaultSettings() };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`invalid JSON: ${err.message}`], settings: defaultSettings() };
  }
  return migrate(parsed);
}

export function exportForEngine(settings) {
  const res = validate(settings);
  if (!res.ok) throw new Error(`cannot export invalid settings: ${res.errors.join("; ")}`);
  const eff = effectiveSettings(res.settings);
  return {
    mode: eff.mode,
    language: eff.language,
    speed: eff.gameSpeed,
    assist: eff.combatAssist,
    travel: eff.fastTravel,
    music: eff.musicVolume,
    sfx: eff.sfxVolume,
  };
}
