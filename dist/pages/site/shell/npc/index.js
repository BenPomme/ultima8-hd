// web/npc/index.js
// Module entry point. Loaded by the shell (see include.html).
//
// DEFAULT: OFF. On boot this reads persisted settings; unless the panel was
// explicitly enabled by the player, the module returns immediately and the game
// is completely unaffected. Reloading the browser may restore an ENABLED
// setting, but an OFF setting never changes game controls and never attaches a
// listener.
//
// There is NO save export/import integration: `integration.patch` is deleted and
// must not be applied. Memory is per-playthrough in localStorage and "New
// playthrough / forget all" clears it.
//
// Persisted settings key: npcchat:settings:v1 (localStorage).

import { createChatController, DEFAULT_SETTINGS } from "./chat.js";
import { mountPanel, unmountPanel } from "./panel.js";
import { createBridgeReader } from "./bridge-adapter.js";

export const SETTINGS_KEY = "npcchat:settings:v1";

function readSettings(storage) {
  try {
    const text = storage?.getItem?.(SETTINGS_KEY);
    if (!text) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
    return {
      panelEnabled: parsed.panelEnabled === true,
      ttsEnabled: parsed.ttsEnabled === true,
      ttsVolume: Number.isFinite(parsed.ttsVolume) ? parsed.ttsVolume : DEFAULT_SETTINGS.ttsVolume,
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

function writeSettings(storage, settings) {
  try { storage?.setItem?.(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

function safeStorage(win) {
  try { return win?.localStorage ?? null; } catch { return null; }
}

// Boot the module in a browser. Returns null when the panel is off (inert).
export function boot(win = globalThis) {
  const storage = safeStorage(win);
  const settings = readSettings(storage);
  if (!settings.panelEnabled) return null; // INERT PATH

  const controller = createChatController({
    storage,
    document: win.document,
    window: win,
    settings,
    endpoint: resolveEndpoint(win),
    reader: createBridgeReader(win.document),
  });
  const view = mountPanel(win, controller, { applyOption: (index, expected) => controller.reader.selectOption(index, expected) });
  return { controller, view, settings, unmount: () => unmountPanel(win, controller) };
}

// Enable / disable from settings UI (host may call these). The toggles are
// actually mounted and accessible to the user via the panel controls.
export function enable(win = globalThis) {
  const storage = safeStorage(win);
  const settings = { ...readSettings(storage), panelEnabled: true };
  writeSettings(storage, settings);
  return boot(win);
}

export function disable(win = globalThis) {
  const storage = safeStorage(win);
  const settings = { ...readSettings(storage), panelEnabled: false };
  writeSettings(storage, settings);
  const existing = win?.document?.getElementById?.("npc-chat-panel");
  if (existing) existing.remove();
  return null;
}

const TOGGLE_ID = "npc-chat-toggle";
let active = null;

export function mountToggle(win = globalThis) {
  const doc = win?.document; if (!doc?.body || doc.getElementById(TOGGLE_ID)) return;
  const b = doc.createElement("button");
  b.id = TOGGLE_ID; b.type = "button";
  b.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:2147483000;font:12px sans-serif;padding:4px 8px;opacity:.85";
  const sync = () => {
    const on = readSettings(safeStorage(win)).panelEnabled;
    b.textContent = on ? "NPC chat: On" : "NPC chat: Off";
    b.setAttribute("aria-pressed", String(on));
  };
  b.addEventListener("click", (e) => {
    e.stopPropagation(); b.blur(); // never leave focus stealing game keys
    if (readSettings(safeStorage(win)).panelEnabled) { active?.unmount?.(); active = null; disable(win); }
    else { active = enable(win); }
    sync();
  });
  sync(); doc.body.appendChild(b);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const start = () => { try { mountToggle(window); active = boot(window); } catch {} };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", start, { once: true }) : start();
}

export { createChatController, DEFAULT_SETTINGS, mountPanel, unmountPanel };

import { resolveEndpoint } from "./config.js";
