// web/npc/avatar.js
// Avatar guard and fail-closed speaker guard.
//
// The bridge reports the speaker-0 / main-actor object id for the PLAYER. That
// object must never be stored as an NPC, and barks emitted by it must never
// enter an NPC's "heard" lines. Both checks are data-driven from the live state;
// no id is hardcoded.

// Read the avatar object id from a bridge state object, tolerating the several
// spellings the native contract may use. Returns an array of candidate ids.
export function avatarObjIds(state) {
  if (!state || typeof state !== "object") return [];
  const candidates = [
    state.avatarObjId,
    state.mainActorObjId,
    state.speaker0ObjId,
    state.avatar,
    state.mainActor,
  ];
  const ids = [];
  for (const raw of candidates) {
    if (raw === null || raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && !ids.includes(n)) ids.push(n);
  }
  return ids;
}

// True when the speaker under consideration IS the avatar and must be refused.
export function isAvatarSpeaker(speaker, state) {
  const ids = avatarObjIds(state);
  if (!ids.length) return false;
  const raw = speaker?.objId ?? speaker?.speakerObjId;
  if (raw === null || raw === undefined || raw === "") return false;
  const n = Number(raw);
  return Number.isFinite(n) && ids.includes(n);
}

// FAIL-CLOSED guards. Each returns a reason string when the conversation must be
// refused, or null when it may proceed.
//   - speaker objId 0 / missing
//   - avatarObjId missing
//   - speaker === avatar
//   - speakerClass missing or 0 (identity is unknown; refuse rather than guess)
export function refuseReason(state) {
  if (!state || typeof state !== "object") return "no-state";

  const objRaw = state.speakerObjId;
  const objId = objRaw === null || objRaw === undefined || objRaw === "" ? null : Number(objRaw);
  if (objId === null || !Number.isFinite(objId) || objId === 0) return "no-speaker";

  const avatar = avatarObjIds(state);
  if (!avatar.length) return "no-avatar";

  if (avatar.includes(objId)) return "avatar-speaker";

  const classRaw = state.speakerClass;
  const classId = classRaw === null || classRaw === undefined || classRaw === "" ? null : Number(classRaw);
  if (classId === null || !Number.isFinite(classId) || classId === 0) return "no-speaker-class";

  return null;
}

// Filter barks: drop any line whose objId is the avatar's, and (when a speaker
// filter is supplied) optionally keep only the current speaker's lines.
// Returns an array of plain strings — the "heard" lines.
export function heardLines(barks, state, { speakerObjId = null, sameSpeakerOnly = false } = {}) {
  const blocked = new Set(avatarObjIds(state));
  const want = speakerObjId === null || speakerObjId === undefined ? null : Number(speakerObjId);
  const out = [];
  for (const bark of Array.isArray(barks) ? barks : []) {
    if (!bark) continue;
    const objId = bark.objId === null || bark.objId === undefined ? null : Number(bark.objId);
    if (objId !== null && blocked.has(objId)) continue;           // avatar bark
    if (sameSpeakerOnly && want !== null && objId !== want) continue;
    const text = String(bark.text ?? "").replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out;
}
