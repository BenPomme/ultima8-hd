// store-sqlite.mjs — store adapter over SQLite (Cloudflare DO SQL or node:sqlite).
// Reads use adapter.all, writes use adapter.run, atomicity via adapter.tx.
// Helpers rowsOf/cfDb/nodeDb are host-applied (2b); makeSqliteStore is rewritten
// here to use them exclusively (the earlier db.exec wiring was wrong).

function rowsOf(r) {
  if (r == null) return [];
  if (Array.isArray(r)) return r;
  if (typeof r.toArray === "function") return r.toArray();
  if (typeof r[Symbol.iterator] === "function") return [...r];
  return [];
}
export function cfDb(ctx) {           // ctx = DurableObjectState
  const sql = ctx.storage.sql;
  return {
    all: (q, ...p) => rowsOf(sql.exec(q, ...p)),
    run: (q, ...p) => { rowsOf(sql.exec(q, ...p)); },
    tx: (fn) => ctx.storage.transactionSync(fn),
  };
}
export function nodeDb(db) {          // node:sqlite DatabaseSync
  return {
    all: (q, ...p) => db.prepare(q).all(...p),
    run: (q, ...p) => { db.prepare(q).run(...p); },
    tx: (fn) => {
      db.exec("BEGIN IMMEDIATE");
      try { const r = fn(); db.exec("COMMIT"); return r; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

export function makeSqliteStore(adapter) {
  // Each schema statement is a separate adapter.run.
  adapter.run(`CREATE TABLE IF NOT EXISTS ip_log (ip TEXT NOT NULL, at INTEGER NOT NULL);`);
  adapter.run(`CREATE INDEX IF NOT EXISTS ip_log_ip_at ON ip_log (ip, at);`);
  adapter.run(`CREATE TABLE IF NOT EXISTS holds (id TEXT PRIMARY KEY, ip TEXT NOT NULL, day TEXT NOT NULL, usd REAL NOT NULL, status TEXT NOT NULL, actual_usd REAL, at INTEGER NOT NULL);`);
  adapter.run(`CREATE TABLE IF NOT EXISTS committed (day TEXT PRIMARY KEY, usd REAL NOT NULL);`);
  adapter.run(`CREATE TABLE IF NOT EXISTS trail (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);`);
  adapter.run(`CREATE TABLE IF NOT EXISTS trip (day TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);`);

  return {
    tx(fn) { return adapter.tx(fn); },

    isTripped(day) {
      const rows = adapter.all(`SELECT reason FROM trip WHERE day = ?;`, day);
      return rows.length > 0 ? rows[0].reason : null;
    },
    trip(day, reason, at) {
      adapter.run(`INSERT OR IGNORE INTO trip (day, reason, at) VALUES (?, ?, ?);`, day, reason, at);
    },

    ipCountSince(ip, sinceMs) {
      const rows = adapter.all(`SELECT COUNT(*) AS n FROM ip_log WHERE ip = ? AND at >= ?;`, ip, sinceMs);
      return Number(rows[0]?.n ?? 0);
    },
    recordIp(ip, atMs) {
      adapter.run(`INSERT INTO ip_log (ip, at) VALUES (?, ?);`, ip, atMs);
      adapter.run(`DELETE FROM ip_log WHERE at < ?;`, atMs - 3600_000);
    },
    dayTotals(day) {
      const c = adapter.all(`SELECT usd FROM committed WHERE day = ?;`, day);
      const committedUsd = Number(c[0]?.usd ?? 0);
      const h = adapter.all(`SELECT usd FROM holds WHERE day = ? AND status IN ('held','held_unknown');`, day);
      let heldUsd = 0;
      for (const r of h) heldUsd += Number(r.usd);
      return { committedUsd, heldUsd };
    },
    insertHold(id, ip, day, usd, atMs) {
      adapter.run(`INSERT INTO holds (id, ip, day, usd, status, actual_usd, at) VALUES (?, ?, ?, ?, 'held', NULL, ?);`, id, ip, day, usd, atMs);
    },
    getHold(id) {
      const rows = adapter.all(`SELECT id, ip, day, usd, status, actual_usd, at FROM holds WHERE id = ?;`, id);
      const r = rows[0];
      if (!r) return null;
      return { id: r.id, ip: r.ip, day: r.day, usd: Number(r.usd), status: r.status, actualUsd: r.actual_usd == null ? null : Number(r.actual_usd) };
    },
    setHoldStatus(id, status, actualUsd) {
      adapter.run(`UPDATE holds SET status = ?, actual_usd = ? WHERE id = ?;`, status, actualUsd == null ? null : actualUsd, id);
    },
    addCommitted(day, usd) {
      adapter.run(`INSERT INTO committed (day, usd) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd;`, day, usd);
    },
    appendTrail(entry) {
      adapter.run(`INSERT INTO trail (json) VALUES (?);`, JSON.stringify(entry));
    },
    getTrail() {
      const rows = adapter.all(`SELECT json FROM trail ORDER BY seq ASC;`);
      return rows.map((r) => JSON.parse(r.json));
    },
  };
}
