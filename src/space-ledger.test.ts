import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { scanSpaceLedger, codexRuntimeNames, type LedgerConfig } from "./space-ledger.ts";
import { Store } from "./store.ts";
import { summary } from "./stats.ts";
import { Shared, memoryObjectStore } from "./shared.ts";

const NOW = Date.parse("2026-09-23T10:00:00Z");
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "usage-ledger-")); dirs.push(dir);
  const config: LedgerConfig = { dbPath: join(dir, "space.db"), runtimesPath: join(dir, "runtimes.yaml") };
  await Bun.write(config.runtimesPath, "runtimes:\n  worker:\n    kind: codex-cli\n  claude:\n    kind: claude-code\n");
  const db = new Database(config.dbPath!);
  db.exec(`CREATE TABLE model_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT, tag TEXT, model TEXT, runtime TEXT, backend TEXT, origin TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER, input_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, output_tokens INTEGER)`);
  const add = (runtime = "worker", origin = "run", input: number | null = 100, status = "ok", started = NOW) => db.query("INSERT INTO model_calls(app,tag,model,runtime,backend,origin,status,started_at,duration_ms,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens) VALUES ('news','translate','gpt-6-luna',?,'ssh:worker',?,?,?,1000,?,60,0,10)").run(runtime, origin, status, started, input);
  return { db, config, add, dir };
}

test("discovers Codex runtime kinds and workspace paths without assuming a runtime name", () => {
  expect(codexRuntimeNames("runtimes:\n  custom:\n    kind: codex-cli\n  codex:\n    kind: claude-code")).toEqual(["custom"]);
  expect(loadConfig({}, "/home/test").ledger).toEqual({ dbPath: "/home/test/.ai-space/data/space.db", runtimesPath: "/home/test/.ai-space/runtimes.yaml" });
  expect(loadConfig({ SPACE_APP_DATA_DIR: "/custom/data/ai-usage" }, "/home/test").ledger?.dbPath).toBe("/custom/data/space.db");
  expect(loadConfig({ SPACE_HOME: "/space", SPACE_DB: "/other.db", USAGE_SPACE_DB: "none" }).ledger?.dbPath).toBeNull();
  expect(loadConfig({ USAGE_CODEX_RUNTIMES: "old, worker " }).ledger?.runtimeNames).toEqual(["old", "worker"]);
});

test("backfills only ephemeral Codex runs, preserving normalized counters and app/tag attribution", async () => {
  const f = await fixture(); const store = new Store(":memory:");
  try {
    f.add(); f.add("claude"); f.add("worker", "import"); f.add("worker", "task"); f.add("worker", "run", null); f.add("worker", "run", 50, "error");
    const before = f.db.query("SELECT * FROM model_calls").all();
    expect(await scanSpaceLedger(store, f.config, "seoul")).toEqual({ imported: 2, error: null });
    const rows = store.exportSince(0);
    expect(rows.turns[0]).toMatchObject({ input: 100, cache_read: 60, cache_write: 0, output: 10, model: "gpt-6-luna" });
    expect(rows.sessions[0]).toMatchObject({ project: "ai-space/news", topic: "translate · worker · ssh:worker" });
    expect(rows.turns.every((r) => r.message_id.startsWith("space-model:seoul:"))).toBe(true);
    expect(f.db.query("SELECT * FROM model_calls").all()).toEqual(before);
    const stats = summary(store, { range: "all", tz: "UTC", now: NOW + 2000 });
    expect(stats.totals.tokens).toBe(290);
    expect(stats.totals.cost).toBeCloseTo((150 * 0.1 + 120 * 0.01 + 20 * 0.5) / 1e6);
    expect(await scanSpaceLedger(store, f.config, "seoul")).toEqual({ imported: 0, error: null });
  } finally { f.db.close(); store.close(); }
});

test("checkpoints survive restart and id pagination catches late-finishing calls with old timestamps", async () => {
  const f = await fixture(); let store = new Store(join(f.dir, "cache.db"));
  try {
    f.db.transaction(() => { for (let i = 0; i < 505; i++) f.add(); })();
    expect((await scanSpaceLedger(store, f.config, "seoul")).imported).toBe(505);
    store.close(); store = new Store(join(f.dir, "cache.db"));
    expect((await scanSpaceLedger(store, f.config, "seoul")).imported).toBe(0);
    f.add("worker", "run", 10, "ok", NOW - 86400000);
    expect((await scanSpaceLedger(store, f.config, "seoul")).imported).toBe(1);
    expect(store.counts().turns).toBe(506);
    // Retention or a restored source invalidates the anchor. Replaying must not duplicate rows.
    f.db.query("DELETE FROM model_calls WHERE id = 506").run();
    await scanSpaceLedger(store, f.config, "seoul");
    expect(store.counts().turns).toBe(506);
  } finally { f.db.close(); store.close(); }
});

test("machine identities prevent ledger id collisions and shared-store reimports count once", async () => {
  const f = await fixture(); f.add();
  const a = new Store(":memory:"), b = new Store(":memory:"), dashboard = new Store(":memory:");
  try {
    await scanSpaceLedger(a, f.config, "a"); await scanSpaceLedger(b, f.config, "b");
    const objects = memoryObjectStore();
    await new Shared({ store: a, objects, machine: "a", publishOnly: true }).sync(true);
    await new Shared({ store: b, objects, machine: "b", publishOnly: true }).sync(true);
    const hub = new Shared({ store: dashboard, objects, machine: "hub" });
    await hub.sync(true); await hub.sync(true);
    expect(dashboard.counts().turns).toBe(2);
    expect(summary(dashboard, { range: "all", tz: "UTC", now: NOW + 2000 }).totals.tokens).toBe(340);
  } finally { f.db.close(); a.close(); b.close(); dashboard.close(); }
});

test("absent/disabled/old ledgers are harmless; schema failures are observable and retryable", async () => {
  const f = await fixture(); const store = new Store(":memory:");
  try {
    expect(await scanSpaceLedger(store, { ...f.config, dbPath: null }, "local")).toEqual({ imported: 0, error: null });
    const absent = join(f.dir, "missing.db");
    expect(await scanSpaceLedger(store, { ...f.config, dbPath: absent }, "local")).toEqual({ imported: 0, error: null });
    expect(await Bun.file(absent).exists()).toBe(false);
    f.db.exec("DROP TABLE model_calls; CREATE TABLE model_calls(id INTEGER)");
    expect(await scanSpaceLedger(store, f.config, "local")).toEqual({ imported: 0, error: null });
    f.db.exec("ALTER TABLE model_calls ADD COLUMN runtime TEXT");
    expect((await scanSpaceLedger(store, f.config, "local")).error).toContain("Space ledger");
    expect(store.counts().turns).toBe(0);
  } finally { f.db.close(); store.close(); }
});
