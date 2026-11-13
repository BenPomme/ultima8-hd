// web/npc/prompt.js
// Builds the /api/npc request body (schema-valid prompt) for one NPC turn.
//
// Invariants enforced here:
//  - The prompt is assembled ONLY from: the persona (card or generic), the
//    options CURRENTLY offered by native, the barks actually heard, and the
//    memory record for THIS speaker. No other NPC's memory can reach it.
//  - Future-plot knowledge is never injected: the persona's `knowledge` starts
//    empty and only ever grows from heard barks / offered options.
//  - The Avatar's own barks were already filtered by avatar.js.
//  - Identity is the usecode class. The prompt reports the class, never a shape
//    as an identity.
//  - The model must answer with {reply, option_index|null, memory_note?, facts?}.

import { resolvePersona, speakerIdentity, speakerDisplayName } from "./cards/index.js";
import { heardLines, isAvatarSpeaker, refuseReason } from "./avatar.js";
import { MAX_SUMMARY_CHARS, MAX_TURNS, MAX_FACTS } from "./memory.js";

export const REQUEST_SCHEMA_VERSION = 1;

// The JSON contract the model is asked to produce. Kept in one place so the
// schema-valid test and the runtime agree.
export const REPLY_SCHEMA = Object.freeze({
  type: "object",
  required: ["reply"],
  properties: {
    reply: { type: "string" },
    option_index: { type: ["integer", "null"] },
    memory_note: { type: "string", maxLength: MAX_SUMMARY_CHARS },
    facts: { type: "array", items: { type: "string" }, maxItems: MAX_FACTS },
  },
  additionalProperties: false,
});

// Validate a model reply against REPLY_SCHEMA. Returns {ok, errors, value}.
export function validateReply(raw) {
  const errors = [];
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return { ok: false, errors: ["reply is not JSON"], value: null }; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["reply must be an object"], value: null };
  }
  const reply = value.reply;
  if (typeof reply !== "string" || !reply.trim()) errors.push("reply must be a non-empty string");
  const idx = value.option_index;
  if (!(idx === null || idx === undefined || (Number.isInteger(idx) && idx >= 0))) {
    errors.push("option_index must be an integer >= 0 or null");
  }
  if (value.memory_note !== undefined && typeof value.memory_note !== "string") {
    errors.push("memory_note must be a string when present");
  }
  if (value.facts !== undefined && !Array.isArray(value.facts)) errors.push("facts must be an array when present");
  return {
    ok: errors.length === 0,
    errors,
    value: errors.length === 0 ? {
      reply: String(reply),
      option_index: idx === undefined ? null : idx,
      ...(typeof value.memory_note === "string" ? { memory_note: value.memory_note.slice(0, MAX_SUMMARY_CHARS) } : {}),
      ...(Array.isArray(value.facts) ? { facts: value.facts.filter((f) => typeof f === "string").slice(0, MAX_FACTS) } : {}),
    } : null,
  };
}

// Build the system instruction for one NPC. Deterministic, no secrets, no ids.
export function buildSystemPrompt(persona, { options = [], heard = [] } = {}) {
  const lines = [];
  lines.push(`You are ${persona.name}, ${persona.job} in the city of Tenebrae. Stay in character at all times.`);
  lines.push(`Voice: ${(persona.voice?.traits ?? []).join(", ") || "plain"}. Temperament: ${persona.voice?.temperament ?? "even"}.`);
  lines.push(`Attitude toward the Avatar: ${persona.attitude?.stance ?? "neutral"} — ${persona.attitude?.note ?? ""}`.trim());
  if (persona.rumors?.length) lines.push(`Things you have heard around town: ${persona.rumors.join(" ")}`);
  if (persona.knowledge?.length) lines.push(`Things you know from this conversation: ${persona.knowledge.join(" ")}`);
  lines.push("You know ONLY what is listed above and what the Avatar has told you. Never invent events you have not been told. Never reveal future plot, and never claim knowledge of places or people you were not told about.");
  lines.push("If the Avatar is rude, react in character with annoyance, fear or coldness — do not lecture.");
  lines.push("If the Avatar is off-topic, answer briefly in character, then steer back to what you know.");
  lines.push("Answer in 1-3 short sentences of spoken dialogue only. No narration, no stage directions, no quotation marks around the whole reply.");
  lines.push("When the Avatar's message is best answered by one of the numbered choices the game is offering, set option_index to that number (0-based). Otherwise set option_index to null. NEVER change the game state yourself.");
  lines.push(`Return STRICT JSON only: {"reply": string, "option_index": integer|null, "memory_note": string}.`);
  lines.push(`memory_note is an optional update to your rolling memory of the Avatar, at most ${MAX_SUMMARY_CHARS} characters: new durable facts only (their stated name, promises, slights, what they asked). Omit it when nothing durable was said.`);
  if (options.length) lines.push(`Currently offered game choices: ${options.map((o, i) => `[${i}] ${o}`).join(" ")}`);
  if (heard.length) lines.push(`Overheard nearby (not necessarily addressed to you): ${heard.slice(-8).join(" ")}`);
  return lines.join("\n");
}

// Build the full request body for POST /api/npc.
//
// `state` is the native u8npc_get_state() snapshot:
//   {askOpen, speakerObjId, speakerShape, speakerClass, permanentNpc,
//    speakerName?, speakerSource?, options:[string], recentBarks:[{objId,text}],
//    avatarObjId}
//
// `memoryRecord` MUST be the record for this speaker only (from memory.js).
export function buildRequest(state, memoryRecord, { playerText = "", cards = undefined, history = null } = {}) {
  if (!state || typeof state !== "object") throw new Error("buildRequest: state is required");

  const speaker = {
    objId: state.speakerObjId,
    speakerObjId: state.speakerObjId,
    speakerShape: state.speakerShape,
    speakerClass: state.speakerClass,
    permanentNpc: state.permanentNpc === true,
    speakerName: state.speakerName,
  };

  // Fail-closed: no speaker, no avatar id, speaker IS the avatar, or unknown
  // class -> refuse.
  const reason = refuseReason(state);
  if (reason) return { ok: false, reason, request: null };
  // Belt-and-braces on the avatar check (kept explicit for clarity).
  if (isAvatarSpeaker(speaker, state)) {
    return { ok: false, reason: "avatar-speaker", request: null };
  }

  const identity = speakerIdentity(speaker);
  if (!identity) return { ok: false, reason: "no-speaker-class", request: null };

  const options = (Array.isArray(state.options) ? state.options : []).map((o) => String(o));
  const heard = heardLines(state.recentBarks, state, { sameSpeakerOnly: false });
  const persona = resolvePersona(speaker, heard, cards);

  const record = memoryRecord ?? null;
  const turns = Array.isArray(record?.turns) ? record.turns.slice(-MAX_TURNS) : [];
  const summary = typeof record?.summary === "string" ? record.summary.slice(0, MAX_SUMMARY_CHARS) : "";
  const facts = Array.isArray(record?.facts) ? record.facts.slice(-MAX_FACTS) : [];

  const body = {
    v: REQUEST_SCHEMA_VERSION,
    npc: {
      key: identity,
      name: speakerDisplayName(speaker, cards),
      classId: speaker.speakerClass ?? null,
      permanentNpc: speaker.permanentNpc === true,
      shape: state.speakerShape ?? null,   // informational only, never an identity
      objId: state.speakerObjId ?? null,
      persona: {
        job: persona.job,
        voice: persona.voice,
        attitude: persona.attitude,
        rumors: persona.rumors ?? [],
        knowledge: persona.knowledge ?? [],
        generic: persona.generic === true,
      },
    },
    system: buildSystemPrompt(persona, { options, heard }),
    context: {
      options,
      heard,
      // The N3 contract: summary + facts + last 8 turns for THIS speaker only,
      // with no other NPC's barks mixed in.
      memory: { summary, facts, turns },
    },
    messages: [
      ...turns.map((t) => ({ role: t.role === "npc" ? "assistant" : "user", content: t.text })),
      ...(playerText ? [{ role: "user", content: String(playerText) }] : []),
    ],
    response_format: { type: "json_object" },
    response_schema: REPLY_SCHEMA,
    temperature: 0.8,
    max_tokens: 300,
    history: history ?? null,
  };
  return { ok: true, reason: null, request: body };
}
