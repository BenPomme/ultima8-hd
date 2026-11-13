// web/npc/api.js
// Transport to the server-side /api/npc proxy.
//
// HARD RULES:
//  - The browser NEVER talks to a model provider directly. There is no API key
//    anywhere in this module, and none may be added.
//  - The proxy owns rate/spend protection; this client only reports what it got.
//
// Contract (N3, proposed):
//   POST /api/npc   body = buildRequest(...).request
//   200 -> {reply, option_index|null, memory_note?, facts?}   (or a JSON string)
//   non-2xx -> {error: string} (surfaced verbatim, never swallowed)

import { validateReply } from "./prompt.js";

export const NPC_ENDPOINT = "/api/npc";
export const DEFAULT_TIMEOUT_MS = 45000;

// A minimal fetch wrapper. `fetchImpl` is injectable so Node tests can drive it
// without a network. Returns a discriminated result; it never throws on a
// transport failure the caller could reasonably handle.
export async function requestReply(body, { fetchImpl = globalThis.fetch, signal = null, timeoutMs = DEFAULT_TIMEOUT_MS, endpoint = NPC_ENDPOINT } = {}) {
  if (typeof fetchImpl !== "function") return { ok: false, kind: "no-transport", error: "fetch is unavailable" };

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, timeoutMs);
  }
  const onAbort = () => { try { controller?.abort(); } catch { /* ignore */ } };
  if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

    if (!res.ok) {
      const message = parsed?.error ?? (text ? text.slice(0, 300) : `HTTP ${res.status}`);
      return { ok: false, kind: "http", status: res.status, error: String(message) };
    }
    const checked = validateReply(parsed ?? text);
    if (!checked.ok) return { ok: false, kind: "schema", status: res.status, error: checked.errors.join("; "), raw: text.slice(0, 300) };
    return { ok: true, kind: "ok", status: res.status, reply: checked.value };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return { ok: false, kind: aborted ? "timeout" : "network", error: String(err?.message ?? err) };
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort);
  }
}

// An offline/deterministic stand-in used ONLY by unit tests and by the inert
// panel-off path. It is never selected in the shipped runtime: callers must pass
// a real transport. It echoes nothing about the game and changes no state.
export function createMockTransport(script = []) {
  let i = 0;
  return async function mockFetch(_url, init) {
    const body = init?.body ? JSON.parse(init.body) : {};
    const next = script[i] ?? script[script.length - 1] ?? { reply: "(no scripted reply)" };
    i += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        const payload = typeof next === "function" ? await next(body, i) : await next;
        return typeof payload === "string" ? payload : JSON.stringify(payload);
      },
    };
  };
}
