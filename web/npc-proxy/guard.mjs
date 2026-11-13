// guard.mjs — storage-agnostic guard logic (reserve/reconcile) shared by
// the Durable Object (SQLite) and the Node QA server (node:sqlite).
// All mutating operations run inside a single store.tx (serialized/transactional).

import { DAY_CAP_USD, WARN_USD, IP_LIMIT_PER_MIN, utcDayKey } from "./handler.mjs";

// A `store` must implement:
//   tx(fn)                     -> run fn atomically
//   isTripped(day)             -> reason|null
//   trip(day, reason, atMs)    -> void
//   ipCountSince(ip, sinceMs)  -> integer
//   recordIp(ip, atMs)         -> void
//   dayTotals(day)             -> { committedUsd, heldUsd }
//   insertHold(id, ip, day, usd, atMs) -> void
//   getHold(id)                -> { id, usd, status, day } | null
//   setHoldStatus(id, status, actualUsd) -> void
//   addCommitted(day, usd)     -> void
//   appendTrail(entry)         -> void
//   getTrail()                 -> array

export function makeGuard(store, now = () => Date.now()) {
  return {
    reserve(ip, worstUsd) {
      return store.tx(() => {
        const at = now();
        const day = utcDayKey(at);

        // 1. Tripped day -> 503.
        const tripped = store.isTripped(day);
        if (tripped) {
          store.appendTrail({ type: "reject_tripped", ip, at, day, reason: tripped });
          return { status: 503, reason: "tripped", day };
        }

        // 2. IP rate limit -> 429.
        const since = at - 60_000;
        const ipCount = store.ipCountSince(ip, since);
        if (ipCount >= IP_LIMIT_PER_MIN) {
          store.appendTrail({ type: "reject_ip_limit", ip, at, count: ipCount });
          return { status: 429, reason: "ip_rate_limit", retry_after_s: 60 };
        }

        // 3. Day cap -> 503.
        const { committedUsd, heldUsd } = store.dayTotals(day);
        const projected = committedUsd + heldUsd + worstUsd;
        if (projected > DAY_CAP_USD) {
          store.appendTrail({ type: "reject_day_cap", ip, at, day, projected, committedUsd, heldUsd, worstUsd });
          return { status: 503, reason: "out_of_day_budget", day, projected };
        }

        // 4. Insert hold.
        const id = crypto.randomUUID();
        store.insertHold(id, ip, day, worstUsd, at);
        store.recordIp(ip, at);
        const total = committedUsd + heldUsd + worstUsd;
        const warn = total >= WARN_USD;
        store.appendTrail({ type: "reserve", id, ip, at, day, worstUsd, total, warn });
        return { status: 200, id, warn, total };
      });
    },

    // reconcile(id, actualUsd|null) -> { status, known, retained? }
    // Known amount -> committed. Null -> held_unknown, hold never released.
    reconcile(id, actualUsd) {
      return store.tx(() => {
        const at = now();
        const hold = store.getHold(id);
        if (!hold) {
          store.appendTrail({ type: "reconcile_missing", id, at });
          return { status: 404, reason: "unknown_hold" };
        }
        if (hold.status !== "held") {
          store.appendTrail({ type: "reconcile_duplicate", id, at, status: hold.status });
          return { status: 409, reason: "already_reconciled" };
        }
        if (actualUsd === null || actualUsd === undefined) {
          store.setHoldStatus(id, "held_unknown", null);
          store.appendTrail({ type: "reconcile_unknown", id, at, retainedUsd: hold.usd });
          return { status: 200, known: false, retained: hold.usd };
        }
        if (typeof actualUsd !== "number" || !Number.isFinite(actualUsd) || actualUsd < 0) {
          store.setHoldStatus(id, "held_unknown", null);
          store.appendTrail({ type: "reconcile_malformed", id, at, retainedUsd: hold.usd });
          return { status: 200, known: false, retained: hold.usd };
        }
        // Record the ACTUAL bill, never the hold.
        store.setHoldStatus(id, "settled", actualUsd);
        store.addCommitted(hold.day, actualUsd);
        // Overrun: actual exceeds the hold -> trip the day.
        if (actualUsd > hold.usd) {
          store.trip(hold.day, "overrun", at);
          store.appendTrail({ type: "trip_overrun", id, at, day: hold.day, actualUsd, heldUsd: hold.usd });
        }
        store.appendTrail({ type: "reconcile_known", id, at, actualUsd });
        return { status: 200, known: true, actualUsd };
      });
    },

    trail() {
      return store.getTrail();
    },
  };
}
