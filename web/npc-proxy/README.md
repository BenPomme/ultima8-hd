# Ultima VIII Web — NPC Proxy (developer notes)

Small backend that lets in-game NPCs reply via an LLM. The browser never sees
the API key. Production modules: handler.mjs, guard.mjs, store-sqlite.mjs,
notes.mjs, server.mjs (Node), worker.mjs (Cloudflare Worker).

## Model and limits (as shipped)
- OpenRouter, google/gemini-2.5-flash-lite, provider pinned to Google AI Studio
  (standard tier, ~USD 0.10 / 0.40 per million input/output tokens).
  No provider fallback, no automatic retries.
- max_tokens 300; upstream timeout 25 s; client timeout 45 s.
- Spend guard: global USD 3/day hard stop, warning at USD 2/day;
  12 requests per IP per minute; no per-session cap.
- On upstream failure the panel shows a technical status; the request
  is not retried.

## Memory and privacy
NPC memory lives only in the player's browser (local storage), per playthrough.
"Forget this NPC" in the dialogue panel deletes that NPC's memory. There is no
server-side memory, account, sync, save import or export. The server keeps
only spend/rate-limit accounting (SQLite or Durable Object). It stores no
conversation text.

## Node backend (local/private QA)
Environment variables read:
- OPENROUTER_KEY: required for live NPC chat. Never commit it.
- PORT: default 8086.
- NPC_GUARD_DB: SQLite path. Default ":memory:" (non-persistent).

Allowed origins are NOT configurable by environment. Node uses
opts.allowedOrigins (programmatic only) or the built-in defaults:
  https://benpomme.github.io, http://127.0.0.1:8058, http://127.0.0.1:8070
To change origins, pass allowedOrigins when constructing the server.

## Cloudflare Worker (hosted)
- Secret: OPENROUTER_KEY (wrangler secret put OPENROUTER_KEY)
- Var: ALLOWED_ORIGINS (comma-separated)
- Durable Object binding: NPC_GUARD, migration tag v1
- Limits: global USD 3/day hard stop, warning at USD 2/day;
  12 requests per IP per minute; no per-session cap.

## Frontend wiring
<meta name="npcchat-endpoint" content="https://<worker-host>/api/npc">
Without the meta tag, the game shows a friendly "NPC chat not configured" message.
If the upstream is unavailable, the panel currently shows a technical status
(e.g. "http: upstream_error" / "upstream_unavailable").

## Not verified
Text-to-speech, NPCs other than the tested one (Devon), and combat changes are
not verified. See KNOWN-ISSUES.
