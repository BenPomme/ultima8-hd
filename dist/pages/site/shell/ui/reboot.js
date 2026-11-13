// shell/ui/reboot.js
// The restart handshake between two boots of the shell. A restart changes the
// engine's audio driver, which the engine only applies on a NEW start, so the
// shell writes a tiny, VALIDATED token to sessionStorage and then really
// remounts (or reloads). On the next boot the token drives an autoboot that
// skips the title and, when requested, resumes save slot 1. If storage cannot
// be written the restart MUST NOT proceed — the caller shows a visible error.

export const RESUME_TOKEN_KEY = "ultima8.shell.resume.v1";

const SOURCES = new Set(["fm", "gm"]);

function validToken(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.v !== 1) return null;
  if (!SOURCES.has(value.source)) return null;
  const slot = value.resumeSlot;
  if (slot !== null && slot !== undefined && slot !== 1) return null;
  return { v: 1, source: value.source, resumeSlot: slot === 1 ? 1 : null };
}

// Store the token AND read it back, so a sessionStorage that silently drops the
// write is treated exactly like one that throws: the caller sees `false` and
// refuses to restart. Returns true only on a confirmed durable write.
export function saveResumeToken(sessionStorage, token) {
  const clean = validToken({ v: 1, ...token });
  if (!clean) return false;
  if (!sessionStorage || typeof sessionStorage.setItem !== "function") return false;
  const text = JSON.stringify(clean);
  try {
    sessionStorage.setItem(RESUME_TOKEN_KEY, text);
    if (typeof sessionStorage.getItem === "function" && sessionStorage.getItem(RESUME_TOKEN_KEY) !== text) return false;
    return true;
  } catch { return false; }
}

export function readResumeToken(sessionStorage) {
  if (!sessionStorage || typeof sessionStorage.getItem !== "function") return null;
  let text = null;
  try { text = sessionStorage.getItem(RESUME_TOKEN_KEY); } catch { return null; }
  if (!text) return null;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { return null; }
  return validToken(parsed);
}

export function clearResumeToken(sessionStorage) {
  if (!sessionStorage || typeof sessionStorage.removeItem !== "function") return;
  try { sessionStorage.removeItem(RESUME_TOKEN_KEY); } catch { /* ignore */ }
}

// Best-effort `--save-slot` engine URL. The engine is an Emscripten build whose
// argv is the STRING AFTER the URL fragment (the real URL is
// `../scummvm.html#ultima8`), and ScummVM rejects an option that trails the
// target with `this.program: Stray argument 'ultima8'`. The option must come
// BEFORE the target game id, so we insert it right after `#`, keep the target
// last, and never add a second copy or drop the path/search/fragment. The shell
// still issues a real `load(1)` once the world is READY, so the resume is never
// dependent on this URL form.
export function withSaveSlot(baseUrl, slot) {
  if (slot !== 1 || typeof baseUrl !== "string") return baseUrl;
  const hash = baseUrl.indexOf("#");
  if (hash < 0) return baseUrl;                 // no fragment => no engine argv
  const before = baseUrl.slice(0, hash + 1);
  const target = baseUrl.slice(hash + 1);
  if (/(^|\s)--save-slot=/.test(target)) return baseUrl;   // already present
  return target ? `${before}--save-slot=${slot} ${target}` : `${before}--save-slot=${slot}`;
}
