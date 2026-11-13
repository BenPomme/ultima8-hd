// Public, non-secret NPC backend URL. Resolution order:
// 1) <meta name="npcchat-endpoint" content="https://...workers.dev/api/npc">
// 2) window.NPCCHAT_ENDPOINT
// Empty => not configured: visible message, no model call.
export function resolveEndpoint(win = globalThis) {
  try {
    const m = win?.document?.querySelector?.('meta[name="npcchat-endpoint"]');
    const v = (m?.getAttribute("content") || win?.NPCCHAT_ENDPOINT || "").trim();
    if (!v) return null;
    const u = new URL(v, win.location?.href);
    if (u.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}
export const NOT_CONFIGURED_MSG =
  "NPC conversations aren't available in this version. You can keep playing normally.";
export const NOT_CONFIGURED_KIND = "unavailable";
