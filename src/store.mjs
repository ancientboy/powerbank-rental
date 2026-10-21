import { seed, Fault } from "./domain.mjs";
export class MemoryStore {
  constructor(initial = seed()) {
    this.state = structuredClone(initial);
    this.tail = Promise.resolve();
  }
  async read() {
    return structuredClone(this.state);
  }
  async transact(fn) {
    const run = this.tail.then(() => {
      const copy = structuredClone(this.state);
      const result = fn(copy);
      this.state = copy;
      return result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
}
export class D1Store {
  constructor(db, workspaceId = "workspace") {
    this.db = db;
    this.workspaceId = workspaceId;
  }
  async initialize() {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO demo_state (id, revision, payload) VALUES (?, ?, ?)",
      )
      .bind(this.workspaceId, 0, JSON.stringify(seed()))
      .run();
  }
  async read() {
    await this.initialize();
    const row = await this.db
      .prepare("SELECT revision, payload FROM demo_state WHERE id = ?")
      .bind(this.workspaceId)
      .first();
    return JSON.parse(row.payload);
  }
  async transact(fn) {
    await this.initialize();
    for (let attempt = 0; attempt < 12; attempt++) {
      const row = await this.db
        .prepare("SELECT revision, payload FROM demo_state WHERE id = ?")
        .bind(this.workspaceId)
        .first();
      const state = JSON.parse(row.payload);
      const result = fn(state);
      const write = await this.db
        .prepare(
          "UPDATE demo_state SET revision = ?, payload = ? WHERE id = ? AND revision = ?",
        )
        .bind(
          row.revision + 1,
          JSON.stringify(state),
          this.workspaceId,
          row.revision,
        )
        .run();
      if (write.meta.changes === 1) return result;
    }
    throw new Fault(
      "BUSY_RETRY",
      "The demo is busy. Retry with the same request key.",
      503,
    );
  }
}
