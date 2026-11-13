// shell/ui/feedback/haptics.js
// Thin wrapper over the Vibration API. Android Chrome supports it; iOS Safari
// does not, and desktop returns undefined. Callers never branch on support: an
// unsupported or disabled device simply no-ops. The `navigator` is injected so
// the module is testable under Node.
export function createHaptics(options = {}) {
  const nav = options.navigator ?? (typeof navigator !== "undefined" ? navigator : null);
  const supported = typeof nav?.vibrate === "function";
  let enabled = options.enabled !== false;

  function vibrate(pattern) {
    if (!enabled || !supported || !pattern) return false;
    const seq = Array.isArray(pattern) ? pattern : [pattern];
    if (!seq.length || seq.every((n) => !(Number(n) > 0))) return false;
    try { return nav.vibrate(seq) === true; } catch { return false; }
  }

  return {
    supported,
    isEnabled: () => enabled,
    setEnabled(value) { enabled = Boolean(value); return enabled; },
    vibrate,
  };
}
