// web/npc/tts.js
// Optional read-aloud of NPC replies via browser SpeechSynthesis.
//
// OFF BY DEFAULT. Nothing here touches the game; when the toggle is off no
// speechSynthesis object is even consulted. If no voice is available, or the API
// is missing, speaking falls back SILENTLY (returns a reason, throws nothing).

export const TTS_DEFAULT_ENABLED = false;

export function speechSupported(win = globalThis) {
  try { return Boolean(win && typeof win.speechSynthesis === "object" && win.speechSynthesis !== null && typeof win.SpeechSynthesisUtterance === "function"); } catch { return false; }
}

// Pick a voice for a card's hints. Gender/pitch hints are advisory: a mismatch
// never blocks speech, it only orders the candidates.
export function pickVoice(voices, hints = {}) {
  const list = Array.isArray(voices) ? voices.filter(Boolean) : [];
  if (!list.length) return null;
  const want = String(hints.gender_hint ?? "any").toLowerCase();
  const scored = list.map((voice) => {
    let score = 0;
    const name = String(voice.name ?? "").toLowerCase();
    const lang = String(voice.lang ?? "").toLowerCase();
    if (lang.startsWith("en")) score += 3;
    if (want === "male" && /male|david|mark|daniel|alex|fred/.test(name) && !/female/.test(name)) score += 4;
    if (want === "female" && /female|zira|samantha|victoria|karen|susan/.test(name)) score += 4;
    if (voice.localService) score += 1;
    if (voice.default) score += 1;
    return { voice, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].voice;
}

// Create a speaker bound to one window. `enabled` is read per call so the
// toggle takes effect immediately.
export function createSpeaker(win = globalThis) {
  let current = null;

  function cancel() {
    if (!speechSupported(win)) return;
    try { win.speechSynthesis.cancel(); } catch { /* ignore */ }
    current = null;
  }

  // Speak `text` for `voiceHints`. Returns {spoken:boolean, reason?:string}.
  function speak(text, voiceHints = {}, { enabled = TTS_DEFAULT_ENABLED, volume = 1, onEnd = null } = {}) {
    if (!enabled) return { spoken: false, reason: "disabled" };
    const clean = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!clean) return { spoken: false, reason: "empty" };
    if (!speechSupported(win)) return { spoken: false, reason: "unsupported" };
    try {
      cancel();
      const utter = new win.SpeechSynthesisUtterance(clean);
      const voice = pickVoice(win.speechSynthesis.getVoices?.() ?? [], voiceHints);
      if (voice) utter.voice = voice;
      if (Number.isFinite(voiceHints.pitch)) utter.pitch = Math.min(2, Math.max(0, Number(voiceHints.pitch)));
      if (Number.isFinite(voiceHints.rate)) utter.rate = Math.min(2, Math.max(0.1, Number(voiceHints.rate)));
      utter.volume = Math.min(1, Math.max(0, Number(volume)));
      if (typeof onEnd === "function") utter.onend = () => onEnd();
      current = utter;
      win.speechSynthesis.speak(utter);
      return { spoken: true, reason: voice ? "voice" : "default-voice" };
    } catch {
      // Silent fallback: a missing/broken speech engine never breaks chat.
      return { spoken: false, reason: "error" };
    }
  }

  return { speak, cancel, get speaking() { return Boolean(current); } };
}
