// worker.mjs — Cloudflare Worker entry + NpcGuard Durable Object.
// All budget checks run inside the DO's serialized request execution.
// Paid calls go through OpenRouter using the OPENROUTER_KEY server secret.

import {
  DEFAULT_ALLOWED_ORIGINS, MAX_BODY_BYTES, originAllowed, corsHeaders, json,
  readBodyCapped, validatePayload, buildOpenRouterBody, callOpenRouter,
  extractModelText, extractUsageCost, parseModelReply, applyOptionIndexConstraint,
  worstCaseUsdForBody, sanitizeError, checkRoute,
} from "./handler.mjs";
import { makeGuard } from "./guard.mjs";
import { makeNotes, routeDetail } from "./notes.mjs";
import { makeSqliteStore, cfDb } from "./store-sqlite.mjs";

export class NpcGuard {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      const adapter = cfDb(ctx);
      this.store = makeSqliteStore(adapter);
      this.guard = makeGuard(this.store);
      this.notes = makeNotes(adapter);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/reserve") {
      const { ip, wcUsd } = await request.json();
      return json(200, this.guard.reserve(ip, wcUsd));
    }
    if (path === "/reconcile") {
      const { id, actualUsd } = await request.json();
      return json(200, this.guard.reconcile(id, actualUsd));
    }
    if (path === "/stats") {
      return json(200, { trail: this.guard.trail() });
    }
    if (path === "/note") {
      const { kind, detail } = await request.json();
      this.notes.add(kind, detail);
      return json(200, { ok: true });
    }
    return json(404, { error: "not_found" });
  }
}

function allowedOrigins(env) {
  if (env.ALLOWED_ORIGINS) {
    return env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

async function guardFetch(env, path, payload) {
  const id = env.NPC_GUARD.idFromName("global");
  const stub = env.NPC_GUARD.get(id);
  const res = await stub.fetch(`https://do.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export default {
  async fetch(request, env, ctx) {
    const allowed = allowedOrigins(env);
    const origin = request.headers.get("origin");
    const url = new URL(request.url);
    const cors = corsHeaders(origin, allowed);

    if (request.method === "OPTIONS") {
      if (!originAllowed(origin, allowed)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }
    if (url.pathname !== "/api/npc") return json(404, { error: "not_found" }, cors);
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, cors);
    if (!originAllowed(origin, allowed)) return json(403, { error: "origin_not_allowed" }, {});

    const bodyRes = await readBodyCapped(request, MAX_BODY_BYTES);
    if (!bodyRes.ok) return json(bodyRes.reason === "body_too_large" ? 413 : 400, { error: bodyRes.reason }, cors);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder().decode(bodyRes.bytes)); }
    catch { return json(400, { error: "invalid_json" }, cors); }

    const v = validatePayload(parsed);
    if (!v.ok) return json(400, { error: v.error }, cors);

    // §2d: build the actual payload first, then price it.
    const body = buildOpenRouterBody(v.value);
    const bodyStr = JSON.stringify(body);
    const wc = worstCaseUsdForBody(bodyStr);

    const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";

    let reserved;
    try {
      reserved = await guardFetch(env, "/reserve", { ip, wcUsd: wc });
    } catch {
      return failClosed(503, cors);
    }

    // §2c admission: only a successful valid reservation admits.
    if (reserved?.status !== 200 || typeof reserved.id !== "string" || !reserved.id) {
      return failClosed(reserved?.status === 429 ? 429 : 503, cors);
    }
    const holdId = reserved.id;
    const rec = async (usd) => { try { await guardFetch(env, "/reconcile", { id: holdId, actualUsd: usd }); } catch {} };
    let r;
    try { r = await callOpenRouter(env, body); }
    catch { await rec(null); return json(502, { error: "upstream_unavailable" }, cors); }
    if (!r || !r.ok || r.status < 200 || r.status >= 300) {
      await rec(null); return json(502, { error: "upstream_error" }, cors);
    }
    const usage = extractUsageCost(r.data && r.data.usage);
    const routeReason = checkRoute(r.data);
    if (routeReason) {
      await rec(usage.known ? usage.usd : null);
      try { await guardFetch(env, "/note", { kind: "route_mismatch", detail: routeDetail(r.data) }); } catch {}
      return json(502, { error: routeReason }, cors);
    }
    if (!usage.known) { await rec(null); return json(502, { error: "usage_unknown" }, cors); }
    await rec(usage.usd);
    const validated = parseModelReply(extractModelText(r.data));
    if (!validated.ok) return json(502, { error: "invalid_model_response" }, cors);
    const constrained = applyOptionIndexConstraint(validated, v.value.options);
    return json(200, { ...constrained.value, warn: !!reserved.warn }, cors);
  },
};

function failClosed(status, cors) {
  return json(status, { error: status === 429 ? "rate_limited" : "guard_unavailable" }, cors);
}
