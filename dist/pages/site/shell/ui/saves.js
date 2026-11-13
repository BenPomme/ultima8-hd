// shell/ui/saves.js
// Save file export / import for the shell.
//
// Export asks the engine for the real save bytes (bridge.exportSave) and hands
// them to the browser as a download. Import reads a user-chosen file and
// forwards the raw bytes to the engine (bridge.importSave); the engine loads the
// slot itself. Every failure path surfaces the engine's own error string;
// nothing is faked and no placeholder saves are written.
//
// The file-name helper is Node-testable; the browser helpers (download, file
// picker) are guarded so importing this module never touches the DOM.

export const SAVE_EXT = "sav";

// A conservative, filesystem-safe name: game + hero + slot. Never contains a
// path separator or control character.
export function saveFileName(hero, slot = 1, ext = SAVE_EXT) {
  const base = String(hero ?? "").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "avatar";
  const s = Number.isInteger(slot) && slot > 0 ? slot : 1;
  return `ultima8-${base}-slot${s}.${ext}`;
}

// Trigger a browser download of `bytes`. Returns the file name used.
export function downloadBytes(doc, name, bytes, mime = "application/octet-stream") {
  if (!doc?.createElement) throw new Error("no document available for download");
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  (doc.body ?? doc.documentElement).appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 2000);
  return name;
}

// Prompt the user for a save file. Resolves with { name, bytes } or null when
// cancelled. Uses a transient <input type=file>; no library.
export function pickSaveFile(doc, accept = `.${SAVE_EXT},application/octet-stream`) {
  return new Promise((resolve) => {
    const input = doc.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; input.remove(); resolve(value); } };
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return done(null);
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        done({ name: file.name, bytes: buf });
      } catch (err) {
        done({ error: String(err?.message ?? err) });
      }
    });
    // A cancelled picker fires no `change` in some engines; `focus` on the
    // window after the dialog closes is the best-effort fallback.
    doc.defaultView?.addEventListener?.("focus", () => setTimeout(() => { if (!input.files?.length) done(null); }, 500), { once: true });
    (doc.body ?? doc.documentElement).appendChild(input);
    input.click();
  });
}
