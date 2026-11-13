// handler.mjs — shared request-handling logic for the NPC proxy.
// Used by worker.mjs (Cloudflare Worker + Durable Object) and server.mjs (Node QA).
// Human constraint: ALL paid model calls go THROUGH OPENROUTER.
// Model: google/gemini-2.5-flash-lite, provider.only=google-ai-studio, no fallbacks,
// data_collection deny, usage.include true. Server secret: OPENROUTER_KEY.

export const MODEL = "google/gemini-2.5-flash-lite";
export const PRICE_IN_PER_M = 0.10; // USD per 1M input tokens
export const PRICE_OUT_PER_M = 0.40; // USD per 1M output tokens
export const MAX_OUTPUT_TOKENS = 300;
export const TEMPERATURE = 0.7; // server-pinned; client value ignored

export const DAY_CAP_USD = 3.0;
export const WARN_USD = 2.0;
export const IP_LIMIT_PER_MIN = 12;
export const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
export const MAX_USER_TEXT = 500;
export const MAX_TURNS = 8;
export const MAX_SUMMARY_CHARS = 600;
export const MAX_FACTS = 12;

// Routing slug used in the request. The response provider display name is
// "Google AI Studio" (verified catalog display name for this slug).
export const PINNED_PROVIDER = "google-ai-studio";
export const PINNED_PROVIDER_DISPLAY = "Google AI Studio";
export const PINNED_MODEL = MODEL;

// Normalized provider identity comparison: accept either the routing slug or the
// verified catalog display name; never compare raw slug vs display name.
export function providerMatches(reported) {
  if (typeof reported !== "string") return false;
  const norm = reported.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return norm === PINNED_PROVIDER || norm === PINNED_PROVIDER_DISPLAY.toLowerCase().replace(/[\s_]+/g, "-");
}

export const DEFAULT_ALLOWED_ORIGINS = [
  "https://benpomme.github.io",
  "http://127.0.0.1:8058",
  "http://127.0.0.1:8070",
];

// Conservative worst-case input-token bound: UTF-8 payload bytes.
export function worstCaseInputTokens(utf8Bytes) {
  return utf8Bytes; // 1 token per byte upper bound
}

// Worst-case USD for a given byte payload, using output at the max.
export function worstCaseUsd(utf8Bytes) {
  const inTok = worstCaseInputTokens(utf8Bytes);
  return (inTok * PRICE_IN_PER_M) / 1e6 + (MAX_OUTPUT_TOKENS * PRICE_OUT_PER_M) / 1e6;
}

// §2d: computed AFTER building the actual outgoing payload body.
export function worstCaseUsdForBody(body) {
  const inBytes = new TextEncoder().encode(body).length + 1024; // + framing/chat-template slack
  return inBytes * 0.10e-6 + 300 * 0.40e-6;
}

export function utcDayKey(ms) {
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

export function json(status, obj, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

export function corsHeaders(origin, allowedOrigins) {
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function originAllowed(origin, allowedOrigins) {
  return typeof origin === "string" && allowedOrigins.includes(origin);
}

export async function readBodyCapped(request, cap = MAX_BODY_BYTES) {
  const cl = request.headers.get("content-length");
  if (cl && Number(cl) > cap) return { ok: false, reason: "body_too_large" };
  const body = request.body;
  if (!body) return { ok: false, reason: "body_missing" };
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { try { await reader.cancel(); } catch {} return { ok: false, reason: "body_too_large" }; }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return { ok: true, bytes: buf };
}

export function validatePayload(obj) {
  if (!obj || typeof obj !== "object") return { ok: false, error: "payload_not_object" };
  const npc = obj.npc;
  if (!npc || typeof npc !== "object") return { ok: false, error: "npc_missing" };
  const system = obj.system;
  if (typeof system !== "string" || system.length === 0) return { ok: false, error: "system_missing" };
  const context = obj.context && typeof obj.context === "object" ? obj.context : {};
  const options = Array.isArray(context.options) ? context.options.filter((x) => typeof x === "string") : [];
  const heard = Array.isArray(context.heard) ? context.heard.filter((x) => typeof x === "string") : [];
  const mem = context.memory && typeof context.memory === "object" ? context.memory : {};
  const summary = typeof mem.summary === "string" ? mem.summary.slice(0, MAX_SUMMARY_CHARS) : "";
  const facts = Array.isArray(mem.facts) ? mem.facts.filter((x) => typeof x === "string").slice(0, MAX_FACTS) : [];
  const turnsIn = Array.isArray(mem.turns) ? mem.turns : [];
  const turns = turnsIn
    .filter((t) => t && typeof t === "object" && (t.role === "player" || t.role === "npc") && typeof t.text === "string")
    .slice(-MAX_TURNS)
    .map((t) => ({ role: t.role, text: t.text, at: t.at }));

  const msgsIn = Array.isArray(obj.messages) ? obj.messages : [];
  const messages = msgsIn
    .filter((m) => m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-(MAX_TURNS + 1));

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return { ok: false, error: "no_user_message" };
  if (lastUser.content.length > MAX_USER_TEXT) return { ok: false, error: "user_text_too_long" };

  return { ok: true, value: { npc, system, options, heard, summary, facts, turns, messages, lastUserText: lastUser.content } };
}

export function buildModelMessages(v) {
  const memBlock = [];
  if (v.summary) memBlock.push(`Memory summary: ${v.summary}`);
  if (v.facts.length) memBlock.push(`Durable facts: ${v.facts.join("; ")}`);
  if (v.turns.length) {
    const t = v.turns.map((x) => `${x.role === "player" ? "Avatar" : v.npc.name || "NPC"}: ${x.text}`).join("\n");
    memBlock.push(`Recent turns:\n${t}`);
  }
  const sys = memBlock.length ? `${v.system}\n\n[Injected memory]\n${memBlock.join("\n")}` : v.system;
  const msgs = [{ role: "system", content: sys }];
  for (const m of v.messages) msgs.push({ role: m.role, content: m.content });
  return msgs;
}

// §2e payload: retains the existing only/data_collection privacy pins AND adds
// require_parameters + max_price. provider.order alone is NOT a substitute.
export function buildOpenRouterBody(v) {
  return {
    model: PINNED_MODEL,
    messages: buildModelMessages(v),
    provider: {
      only: [PINNED_PROVIDER],
      allow_fallbacks: false,
      data_collection: "deny",
      order: [PINNED_PROVIDER],
      require_parameters: true,
      max_price: { prompt: 0.10, completion: 0.40 },
    },
    response_format: { type: "json_object" },
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: TEMPERATURE,
    usage: { include: true },
  };
}

export function extractFirstJsonObject(text) {
  if (text[0] !== "{") return null;               // must start with an object
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return text.slice(0, i + 1); }
  }
  return null;                                     // incomplete => reject
}

export function parseModelReply(rawText) {
  if (typeof rawText !== "string") return { ok: false, error: "no_text" };
  let text = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!text) return { ok: false, error: "empty_text" };
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    const obj = extractFirstJsonObject(text);
    if (!obj) return { ok: false, error: "parse_failed" };
    try { parsed = JSON.parse(obj); } catch { return { ok: false, error: "parse_failed" }; }
  }
  return validateReply(parsed);
}

export function validateReply(obj) {
  if (!obj || typeof obj !== "object") return { ok: false, error: "reply_not_object" };
  const reply = obj.reply;
  if (typeof reply !== "string" || reply.trim().length === 0) return { ok: false, error: "reply_invalid" };
  let option_index = null;
  if (obj.option_index !== undefined && obj.option_index !== null) {
    if (!Number.isInteger(obj.option_index)) return { ok: false, error: "option_index_invalid" };
    option_index = obj.option_index;
  }
  if (obj.memory_note !== undefined && obj.memory_note !== null && typeof obj.memory_note !== "string")
    return { ok: false, error: "memory_note_invalid" };   // null => absent (CP124 authorized)
  const out = { reply, option_index };
  if (typeof obj.memory_note === "string" && obj.memory_note.length > 0) {
    out.memory_note = obj.memory_note.slice(0, MAX_SUMMARY_CHARS);
  }
  if (Array.isArray(obj.facts)) {
    const f = obj.facts.filter((x) => typeof x === "string").slice(0, MAX_FACTS);
    if (f.length) out.facts = f;
  }
  return { ok: true, value: out };
}

export function applyOptionIndexConstraint(validated, options) {
  const v = validated.value;
  if (v.option_index !== null && (v.option_index < 0 || v.option_index >= options.length)) {
    v.option_index = null;
  }
  return validated;
}

// ---- Cost extraction from OpenRouter usage (NEVER trust client) ----
export function extractUsageCost(usage) {
  if (!usage || typeof usage !== "object") return { known: false, usd: null };
  const cost = usage.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return { known: false, usd: null };
  return { known: true, usd: cost };
}

export function sanitizeError(msg) {
  return String(msg == null ? "error" : msg)
    .replace(/sk-[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}

// ---- OpenRouter call (NOT invoked in tests; injected fetch in prod) ----
// Upstream timeout 25s, no retry anywhere.
export async function callOpenRouter(env, openRouterBody, fetchImpl = fetch) {
  const key = env.OPENROUTER_KEY;
  if (!key) return { ok: false, error: "server_misconfigured" };
  const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      "http-referer": "https://benpomme.github.io",
      "x-title": "npc-proxy",
    },
    body: JSON.stringify(openRouterBody),
    signal: AbortSignal.timeout(25000),
  });
  const status = res.status;
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: true, status, data };
}

export function extractModelText(data) {
  if (!data || typeof data !== "object") return null;
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const msg = choices[0].message;
  if (!msg || typeof msg.content !== "string") return null;
  return msg.content;
}

// ---- Route identity check (§2e) ----
// Returns null if valid; otherwise a reason string.
export function checkRoute(data) {
  if (!data || typeof data !== "object") return "route_mismatch";
  const model = data.model;
  if (typeof model !== "string" || !model.startsWith(PINNED_MODEL)) return "route_mismatch";
  if (data.provider !== undefined && data.provider !== null && !providerMatches(data.provider)) return "route_mismatch";
  return null;
}
