// server.mjs — Node 22 LTS local QA server. Same handler-level guard as
// worker.mjs, backed by node:sqlite. LOCAL QA ONLY.
// Missing OPENROUTER_KEY => startup error, not per-request 500.

import { createServer } from "node:http";
import { makeNotes, routeDetail } from "./notes.mjs";
import {
  DEFAULT_ALLOWED_ORIGINS, MAX_BODY_BYTES, originAllowed, corsHeaders, json,
  readBodyCapped, validatePayload, buildOpenRouterBody, callOpenRouter,
  extractModelText, extractUsageCost, parseModelReply, applyOptionIndexConstraint,
  worstCaseUsdForBody, sanitizeError, checkRoute,
} from "./handler.mjs";
import { makeGuard } from "./guard.mjs";
import { makeSqliteStore, nodeDb } from "./store-sqlite.mjs";

function nodeVersionOk() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  return maj > 22 || (maj === 22 && min >= 5);
}

export async function makeStore({ sqlitePath = ":memory:" } = {}) {
  if (!nodeVersionOk()) {
    throw new Error(`node:sqlite requires Node >= 22.5 (found ${process.versions.node}); refusing to start`);
  }
  const mod = await import("node:sqlite");
  const db = new mod.DatabaseSync(sqlitePath);
  const adapter = nodeDb(db);
  return { kind: "sqlite", store: makeSqliteStore(adapter), db, notes: makeNotes(adapter) };
}

export async function createApp(opts = {}) {
  const { store, kind, db, notes } = await makeStore(opts);
  const guard = makeGuard(store, opts.now || (() => Date.now()));
  const allowed = opts.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const fetchImpl = opts.fetchImpl || fetch;

  async function handle(request, rawBytes) {
    const origin = request.headers.origin;
    const cors = corsHeaders(origin, allowed);
    const url = new URL(request.url, "http://localhost");

    if (request.method === "OPTIONS") {
      if (!originAllowed(origin, allowed)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }
    if (url.pathname === "/api/npc/stats") return new Response(null, { status: 404 });
    if (url.pathname !== "/api/npc") return json(404, { error: "not_found" }, cors);
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, cors);
    if (!originAllowed(origin, allowed)) return json(403, { error: "origin_not_allowed" }, {});

    let parsed;
    try { parsed = JSON.parse(new TextDecoder().decode(rawBytes)); }
    catch { return json(400, { error: "invalid_json" }, cors); }

    const v = validatePayload(parsed);
    if (!v.ok) return json(400, { error: v.error }, cors);

    // §2d: build the actual payload first, then price it.
    const body = buildOpenRouterBody(v.value);
    const bodyStr = JSON.stringify(body);
    const wc = worstCaseUsdForBody(bodyStr);

    const ip = request.headers["cf-connecting-ip"] || request.socket?.remoteAddress || "0.0.0.0";

    let reserved;
    try {
      reserved = guard.reserve(ip, wc);
    } catch {
      return json(503, { error: "guard_unavailable" }, cors);
    }
    // §2c admission.
    if (reserved?.status !== 200 || typeof reserved.id !== "string" || !reserved.id) {
      return failClosed(reserved?.status === 429 ? 429 : 503, cors);
    }

    const rec = (usd) => { try { guard.reconcile(reserved.id, usd); } catch {} };
    let r;
    try { r = await callOpenRouter(opts.env || {}, body, fetchImpl); }
    catch { rec(null); return json(502, { error: "upstream_unavailable" }, cors); }
    if (!r || !r.ok || r.status < 200 || r.status >= 300) {
      rec(null); return json(502, { error: "upstream_error" }, cors);
    }
    const usage = extractUsageCost(r.data && r.data.usage);
    const routeReason = checkRoute(r.data);
    if (routeReason) {
      rec(usage.known ? usage.usd : null);
      try { notes.add("route_mismatch", routeDetail(r.data)); } catch {}
      return json(502, { error: routeReason }, cors);
    }
    if (!usage.known) { rec(null); return json(502, { error: "usage_unknown" }, cors); }
    rec(usage.usd);
    const validated = parseModelReply(extractModelText(r.data));
    if (!validated.ok) return json(502, { error: "invalid_model_response" }, cors);
    const constrained = applyOptionIndexConstraint(validated, v.value.options);
    return json(200, { ...constrained.value, warn: !!reserved.warn }, cors);
  }

  return { guard, handle, store, kind, db, notes, allowed };
}

function failClosed(status, cors) {
  return json(status, { error: status === 429 ? "rate_limited" : "guard_unavailable" }, cors);
}

export function startHttpServer(app, port = 8086, host = "127.0.0.1") {
  const server = createServer(async (req, res) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    const cl = req.headers["content-length"];
    if (cl && Number(cl) > MAX_BODY_BYTES) tooLarge = true;
    if (!tooLarge) {
      for await (const chunk of req) {
        total += chunk.byteLength;
        if (total > MAX_BODY_BYTES) { tooLarge = true; break; }
        chunks.push(chunk);
      }
    }
    const raw = tooLarge ? new Uint8Array(0) : Buffer.concat(chunks);
    let resp;
    if (tooLarge) resp = json(413, { error: "body_too_large" }, {});
    else resp = await app.handle(req, raw);
    res.writeHead(resp.status, Object.fromEntries(resp.headers));
    res.end(Buffer.from(await resp.arrayBuffer()));
  });
  return server.listen(port, host);
}

const isMain = process.argv[1] && process.argv[1].endsWith("server.mjs");
if (isMain) {
  if (!process.env.OPENROUTER_KEY) {
    console.error("[npc-proxy] FATAL: OPENROUTER_KEY is not set; refusing to start (fail closed).");
    process.exit(1);
  }
  const app = await createApp({ env: { OPENROUTER_KEY: process.env.OPENROUTER_KEY }, sqlitePath: process.env.NPC_GUARD_DB || ":memory:" });
  const port = Number(process.env.PORT || 8086);
  startHttpServer(app, port, "127.0.0.1");
  console.log(`[npc-proxy] local QA on http://127.0.0.1:${port} (store=${app.kind})`);
}
