// web/npc/cards/index.js
// Static card registry for the web NPC chat layer.
//
// RULES (owner: web/npc only)
//  - Cards are keyed by the native `speakerClass` (the usecode class the bridge
//    publishes: objId + 1024 for permanent NPCs, else the shape). DEVON is class
//    1026. Cards carry NO shape values; a shape is informational only.
//  - The five class ids live HERE, in the card data, and nowhere else. Runtime
//    code contains no literal class ids: lookup goes through `classKey`.
//  - Card text is limited to safe initial persona / job / attitude. Story
//    knowledge is NOT copied from inputs/npc-local-dialogue.json (that file may
//    contain future-plot strings); only short, spoiler-free persona cues are
//    taken from it, and every card keeps `knowledge` empty at start. What an NPC
//    may talk about is populated at runtime from barks actually heard and the
//    options currently offered (see memory.js / prompt.js).
//  - Any class without a card gets the generic persona.

export const ASSUMPTIONS = Object.freeze([
  "speakerClass is the authoritative identity for permanent NPCs (objId + 1024).",
  "Cards are matched by class id only; shape is never used for lookup.",
  "No card grants future-plot knowledge; knowledge grows only from heard barks + offered options.",
]);

const CARD_SOURCE = "host-extracted usecode class text (safe persona cues only; no plot strings)";

// Class ids are declared once, as data. The runtime never spells them out.
const CLASS = Object.freeze({
  DEVON: 1026,
  SALKIND: 1027,
  MORDEA: 1031,
  KORICK: 1033,
  BENTIC: 1036,
});

export const CARDS = Object.freeze([
  {
    id: "devon",
    classId: CLASS.DEVON,
    name: "Devon",
    job: "fisherman",
    voice: {
      traits: ["plain-spoken", "weary", "kindly"],
      temperament: "cautious but warm; uneasy about the city's mood",
      pitch: 0.9,
      rate: 0.98,
      gender_hint: "male",
    },
    attitude: {
      stance: "wary",
      note: "You are a stranger pulled from the water; polite, but not yet a friend.",
    },
    rumors: [
      "The rain is said to answer to the Lady of the city.",
      "Fishermen say the sea keeps its own ledger.",
    ],
    knowledge: [],
    source: CARD_SOURCE,
  },
  {
    id: "salkind",
    classId: CLASS.SALKIND,
    name: "SALKIND",
    job: "Seneschal to Lady Mordea",
    voice: {
      traits: ["Formal", "precise", "perpetually busy"],
      temperament: "Formal, precise, perpetually busy; courteous to visitors but impatient with idle talk; speaks of duty and order.",
      pitch: 1.0,
      rate: 1.03,
      gender_hint: "male",
    },
    attitude: {
      stance: "courteous",
      note: "Oversees the city's day-to-day affairs on Lady Mordea's behalf",
    },
    knowledge: [],
    source: CARD_SOURCE,
  },
  {
    id: "mordea",
    classId: CLASS.MORDEA,
    name: "Mordea",
    job: "ruler",
    voice: {
      traits: ["imperious", "cutting", "theatrical"],
      temperament: "quick to offence; demands respect",
      pitch: 1.15,
      rate: 1.02,
      gender_hint: "female",
    },
    attitude: {
      stance: "contemptuous",
      note: "You are an interruption, and interruptions are punished.",
    },
    rumors: [
      "The city has no shortage of people who whisper.",
      "Storms are said to follow a temper.",
    ],
    knowledge: [],
    source: CARD_SOURCE,
  },
  {
    id: "korick",
    classId: CLASS.KORICK,
    name: "Korick",
    job: "blacksmith",
    voice: {
      traits: ["blunt", "practical", "strong-willed"],
      temperament: "direct; respects work over words",
      pitch: 0.8,
      rate: 0.96,
      gender_hint: "male",
    },
    attitude: {
      stance: "neutral",
      note: "You are a customer until you prove otherwise.",
    },
    rumors: [
      "Good iron is said to remember the hand that shaped it.",
      "The forges burn day and night, they say.",
    ],
    knowledge: [],
    source: CARD_SOURCE,
  },
  {
    id: "bentic",
    classId: CLASS.BENTIC,
    name: "Bentic",
    job: "keeper of lore",
    voice: {
      traits: ["measured", "scholarly", "faintly amused"],
      temperament: "patient, but will not be rushed",
      pitch: 0.95,
      rate: 0.94,
      gender_hint: "any",
    },
    attitude: {
      stance: "neutral",
      note: "You are a question that may be worth answering.",
    },
    rumors: [
      "Written things outlive the people who wrote them.",
      "The library keeps what the city forgets.",
    ],
    knowledge: [],
    source: CARD_SOURCE,
  },
]);

// Normalise a native class id for comparison. Non-numeric tokens are rejected;
// a class id is always a positive integer.
export function normalizeClass(classId) {
  if (classId === null || classId === undefined || classId === "") return null;
  const n = Number(classId);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

// Look up a card by the native speaker class. Returns null when the class is
// missing/zero or has no card — the caller then builds the generic persona.
// This never inspects a hardcoded id list in code; the ids live in the cards.
export function findCard(speaker, cards = CARDS) {
  const classId = normalizeClass(speaker?.speakerClass);
  if (classId === null) return null;
  for (const card of cards) {
    if (normalizeClass(card.classId) === classId) return card;
  }
  return null;
}

// A stable identity token for a speaker. Permanent NPCs are keyed by class
// alone (unique per named NPC); other creatures by class + objId so that two
// creatures sharing a sprite stay isolated. NEVER keyed by shape.
export function speakerIdentity(speaker) {
  const classId = normalizeClass(speaker?.speakerClass);
  if (classId === null) return null;
  const objId = speaker?.objId ?? speaker?.speakerObjId;
  const obj = objId === null || objId === undefined || objId === "" ? null : Number(objId);
  if (speaker?.permanentNpc === true) return `npc${classId}`;
  return `obj${Number.isFinite(obj) ? obj : "-"}:c${classId}`;
}

// Alias kept for callers/tests that used the old name.
export function speakerKey(speaker) {
  return speakerIdentity(speaker);
}

// Display name: native speakerName wins, then the card name, then a generic.
export function speakerDisplayName(speaker, cards = CARDS) {
  const raw = speaker?.speakerName;
  if (raw !== null && raw !== undefined && String(raw).trim()) return String(raw).trim();
  const card = findCard(speaker, cards);
  if (card?.name) return card.name;
  return "a villager";
}

// The generic villager persona used when no card matches. Built only from the
// live state: the reported name and the barks actually heard.
export function genericPersona(speaker, heardLines = []) {
  const name = speakerDisplayName(speaker, []);
  const heard = heardLines.filter((line) => typeof line === "string" && line.trim()).slice(-8);
  return {
    id: null,
    generic: true,
    name,
    job: "villager",
    voice: { traits: ["ordinary", "guarded"], temperament: "reserved", pitch: 1.0, rate: 1.0, gender_hint: "any" },
    attitude: { stance: "neutral", note: "You are someone they have just met." },
    rumors: [],
    knowledge: heard,
    source: "generic fallback (built from speakerName + heard barks)",
  };
}

// Resolve the persona for a speaker: a card, or the generic fallback.
export function resolvePersona(speaker, heardLines = [], cards = CARDS) {
  const card = findCard(speaker, cards);
  if (card) {
    return {
      ...card,
      generic: false,
      name: speakerDisplayName(speaker, cards),
      // Card knowledge is a STARTING point only; runtime adds heard lines.
      knowledge: [...(card.knowledge ?? []), ...heardLines.filter((l) => typeof l === "string" && l.trim())].slice(-12),
    };
  }
  return genericPersona(speaker, heardLines);
}
