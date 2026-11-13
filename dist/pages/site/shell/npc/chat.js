// web/npc/chat.js
// The NPC chat controller: turns native state + memory + one model call into a
// spoken reply and, only when the model picks an ORIGINAL option, a canonical
// native option selection.
//
// Design constraints honoured here:
//  - The panel is OPTIONAL and OFF by default. When disabled, every entry point
//    is inert: no state read, no model call, no DOM, no speech.
//  - No message / session / per-NPC gameplay cap.
//  - Quest effects come ONLY from original options. A free-text reply can never
//    advance the game; only `option_index` naming a currently offered native
//    option is admitted, and only after a fresh re-read of the options list.
//  - Memory is per-NPC and per-playthrough, keyed by the usecode CLASS identity
//    (never by shape). One speaker's record is never part of another's prompt.
//  - The Avatar is never a stored NPC and its barks never become "heard" lines.

import { createMemoryStore, getPlaythroughId, isValidPlaythroughId } from "./memory.js";
import { createBridgeReader } from "./bridge-adapter.js";
import { buildRequest, validateReply } from "./prompt.js";
import { isAvatarSpeaker, refuseReason, heardLines } from "./avatar.js";
import { requestReply } from "./api.js";
import { createSpeaker, TTS_DEFAULT_ENABLED } from "./tts.js";
import { speakerIdentity } from "./cards/index.js";

export const DEFAULT_SETTINGS = Object.freeze({
  panelEnabled: false,   // off by default
  ttsEnabled: TTS_DEFAULT_ENABLED, // off by default
  ttsVolume: 1,
});

export function createChatController(deps = {}) {
  const storage = deps.storage ?? null;
  const doc = deps.document ?? (typeof document !== "undefined" ? document : null);
  const win = deps.window ?? globalThis;
  const fetchImpl = deps.fetchImpl ?? (typeof win.fetch === "function" ? win.fetch.bind(win) : null);
  const endpoint = deps.endpoint ?? null;
  const now = deps.now ?? (() => Date.now());
  const createId = deps.createId;
  const reader = deps.reader ?? createBridgeReader(doc);
  const speaker = deps.speaker ?? createSpeaker(deps.window ?? globalThis);

  const timeoutMs = deps.timeoutMs;

  const store = createMemoryStore(storage, { now, ...(createId ? { createId } : {}) });

  let settings = { ...DEFAULT_SETTINGS, ...(deps.settings ?? {}) };
  let playthroughId = null;

  function ensurePlaythrough() {
    if (!playthroughId) playthroughId = getPlaythroughId(storage, createId);
    return playthroughId;
  }

  // ---- settings -----------------------------------------------------------

  function getSettings() { return { ...settings }; }

  function setSettings(patch = {}) {
    settings = { ...settings, ...patch };
    return getSettings();
  }

  // ---- lifecycle ----------------------------------------------------------

  // New game: a fresh playthrough id, so every NPC starts with empty memory.
  function newGame() {
    playthroughId = store.newPlaythrough(createId);
    return playthroughId;
  }

  function setPlaythroughId(id) {
    if (isValidPlaythroughId(id)) playthroughId = String(id).trim();
    return playthroughId;
  }

  // ---- the one turn -------------------------------------------------------

  // Ask the current speaker one question. `playerText` is what the player typed
  // (free text); it can produce a spoken reply but NEVER a quest effect.
  async function ask(playerText, opts = {}) {
    if (!endpoint) return { ok: false, kind: NOT_CONFIGURED_KIND, error: "not-configured", message: NOT_CONFIGURED_MSG };
    // Panel-off path is INERT: nothing below runs.
    if (!settings.panelEnabled && opts.force !== true) {
      return { ok: false, kind: "disabled", error: "npc chat panel is off" };
    }

    const read = reader.state();
    if (!read.ok) return { ok: false, kind: "bridge", error: read.error };
    const state = read.state;

    // Fail-closed guard: no speaker, no avatar id, speaker IS the avatar, or
    // unknown class. Nothing is stored, sent or shown in these cases.
    const reason = refuseReason(state);
    if (reason) return { ok: false, kind: reason, error: reason };
    if (isAvatarSpeaker({ objId: state.speakerObjId, speakerObjId: state.speakerObjId }, state)) {
      return { ok: false, kind: "avatar-guard", error: "speaker is the Avatar" };
    }
    if (!state.askOpen && !opts.allowClosed) {
      return { ok: false, kind: "closed", error: "no NPC is currently asking" };
    }

    const key = speakerIdentity({
      objId: state.speakerObjId, speakerObjId: state.speakerObjId,
      speakerClass: state.speakerClass, permanentNpc: state.permanentNpc,
      speakerName: state.speakerName,
    });
    if (!key) return { ok: false, kind: "no-speaker-class", error: "no speaker class" };

    const pid = ensurePlaythrough();
    const record = store.ensure(pid, key);

    const built = buildRequest(state, record, { playerText, cards: opts.cards, history: opts.history });
    if (!built.ok) return { ok: false, kind: built.reason, error: built.reason };

    // Stale-choice tuple: the identity of THIS request. A reply is applied only
    // if all four still match the live state.
    const turnId = `${pid}:${key}:${now()}`;
    const expected = {
      speakerObjId: state.speakerObjId,
      speakerClass: state.speakerClass,
      options: built.request.context.options.slice(),
      turnId,
    };

    const transport = opts.fetchImpl ?? fetchImpl;
    if (typeof transport !== "function") return { ok: false, kind: "no-transport", error: "no transport configured" };

    const res = await requestReply(built.request, { fetchImpl: transport, signal: opts.signal, timeoutMs: opts.timeoutMs ?? timeoutMs, endpoint: opts.endpoint ?? endpoint });
    if (!res.ok) return { ok: false, kind: res.kind, error: res.error, status: res.status };

    const reply = res.reply;

    // Staleness check before committing anything: the live speaker and options
    // must still be the ones the request was computed against.
    const live = reader.state();
    if (!live.ok) return { ok: false, kind: "bridge", error: live.error, stale: true };
    const liveState = live.state;
    const sameSpeaker = Number(liveState.speakerObjId) === Number(expected.speakerObjId)
      && Number(liveState.speakerClass) === Number(expected.speakerClass);
    const liveOptions = Array.isArray(liveState.options) ? liveState.options.map(String) : [];
    const sameOptions = liveOptions.length === expected.options.length
      && liveOptions.every((o, i) => o === expected.options[i]);
    if (!sameSpeaker || !sameOptions) {
      return { ok: false, kind: "stale", error: "speaker or options changed", stale: true };
    }

    // Memory update happens through the SAME reply (memory_note) — no extra call.
    const updated = store.applyReply(pid, key, {
      playerText,
      replyText: reply.reply,
      memoryNote: reply.memory_note,
      facts: reply.facts,
    });

    // Quest effects: ONLY an index into the ORIGINAL options, re-validated.
    let applied = null;
    if (reply.option_index !== null && reply.option_index !== undefined) {
      if (!opts.applyOption) {
        applied = { ok: false, error: "no-option-applier" };
      } else {
        applied = opts.applyOption(reply.option_index, expected.options);
      }
    }

    if (settings.ttsEnabled) {
      const hints = built.request.npc.persona.voice ?? {};
      speaker.speak(reply.reply, hints, { enabled: true, volume: settings.ttsVolume, onEnd: opts.onSpeakEnd });
    }

    return { ok: true, kind: "ok", reply: reply.reply, option_index: reply.option_index ?? null, applied, memory: updated, key, playthroughId: pid, request: built.request, turnId };
  }

  // ---- memory controls ----------------------------------------------------

  function currentSpeakerKey() {
    const read = reader.state();
    if (!read.ok) return null;
    const s = read.state;
    return speakerIdentity({
      objId: s.speakerObjId, speakerObjId: s.speakerObjId,
      speakerClass: s.speakerClass, permanentNpc: s.permanentNpc, speakerName: s.speakerName,
    });
  }

  function forgetCurrentNpc() {
    const key = currentSpeakerKey();
    if (!key) return { ok: false, error: "no-speaker" };
    return { ok: store.forget(ensurePlaythrough(), key), key };
  }

  function forgetAllForPlaythrough() {
    const pid = ensurePlaythrough();
    store.forgetAll(pid);
    return { ok: true, playthroughId: pid };
  }

  function readCurrentNpcMemory() {
    const key = currentSpeakerKey();
    if (!key) return null;
    return store.read(ensurePlaythrough(), key);
  }

  // The heard-lines helper for callers that want only this speaker's barks.
  function currentHeardLines(state) {
    const s = state ?? reader.state().state;
    if (!s) return [];
    return heardLines(s.recentBarks, s, { speakerObjId: s.speakerObjId, sameSpeakerOnly: true });
  }

  return {
    getSettings, setSettings, newGame, setPlaythroughId, ensurePlaythrough,
    ask, forgetCurrentNpc, forgetAllForPlaythrough, readCurrentNpcMemory,
    currentSpeakerKey, currentHeardLines, store, reader, speaker,
  };
}

export { validateReply };

import { NOT_CONFIGURED_MSG, NOT_CONFIGURED_KIND } from "./config.js";
