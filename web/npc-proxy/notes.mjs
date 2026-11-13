// notes.mjs — append-only audit trail (route_mismatch etc.). Never stores secrets.
export function makeNotes(adapter) {
  adapter.run("CREATE TABLE IF NOT EXISTS note (at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT)");
  return {
    add: (kind, detail, at = Date.now()) =>
      adapter.run("INSERT INTO note (at, kind, detail) VALUES (?, ?, ?)",
        at, String(kind), JSON.stringify(detail ?? null).slice(0, 500)),
    list: () => adapter.all("SELECT at, kind, detail FROM note ORDER BY rowid"),
  };
}
export function routeDetail(data) {
  return { model: typeof data?.model === "string" ? data.model : null,
           provider: typeof data?.provider === "string" ? data.provider : null };
}
