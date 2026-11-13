// shell/ui/persist.js
// Tiny, defensive localStorage wrapper for the settings profile. `storage` is
// injected so the module is testable without a browser and never throws.
import { serialize, deserialize, defaultSettings } from "../core/settings.js";

export const STORAGE_KEY = "ultima8.shell.settings.v1";

export function loadSettings(storage, isMobile = false) {
  if (!storage || typeof storage.getItem !== "function") return null;
  let text = null;
  try {
    text = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!text) return null;
  // CP69: check raw JSON for artMode BEFORE deserialize/migrate injects defaults
  let rawHasArtMode = false;
  try {
    const raw = JSON.parse(text);
    rawHasArtMode = raw !== null && typeof raw === "object" && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, 'artMode');
  } catch {
    // invalid JSON: deserialize will reject it
  }
  const res = deserialize(text);
  if (!res.ok) return null;
  const stored = res.settings;
  // If artMode was NOT in the raw stored JSON, apply device default.
  if (!rawHasArtMode) {
    stored.artMode = isMobile ? "classic" : "hd2";
  }
  return stored;
}

export function saveSettings(storage, settings) {
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    storage.setItem(STORAGE_KEY, serialize(settings));
    return true;
  } catch {
    return false;
  }
}
