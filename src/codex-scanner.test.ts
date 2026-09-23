import { testCatalog } from "./testing-pricing.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, appendFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCodexTranscript } from "./codex-scanner.ts";
import { loadConfig } from "./config.ts";
import { scanSources } from "./scanner.ts";
import { Store } from "./store.ts";
import { summary } from "./stats.ts";
import { memoryObjectStore, Shared } from "./shared.ts";

const NOW = Date.parse("2026-09-23T10:00:00Z");
const line = (type: string, payload: unknown, time = 0, ordinal?: number) => JSON.stringify({ type, payload, timestamp: new Date(NOW + time).toISOString(), ...(ordinal === undefined ? {} : { ordinal }) });
const meta = (extra: Record<string, unknown> = {}) => line("session_meta", { id: "sid", cwd: "/work/project", git: { branch: "main" }, ...extra });
const context = (model = "gpt-6-astra", extra: Record<string, unknown> = {}) => line("turn_context", { model, ...extra });
const tokens = (input: number, cached: number, output: number, written = 0) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: written, output_tokens: output, reasoning_output_tokens: output, total_tokens: input + output });
const usage = (total: unknown, last: unknown = total, time = 1000, ordinal?: number) => line("event_msg", { type: "token_count", info: { total_token_usage: total, last_token_usage: last } }, time, ordinal);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), "usage-codex-history-")); dirs.push(dir); return dir; }

test("splits cached input, does not add reasoning twice, and prefers turn_context model", () => {
  const parsed = parseCodexTranscript([meta(), context(), usage(tokens(100, 60, 10, 20)), usage(tokens(100, 60, 10, 20), tokens(100, 60, 10, 20), 2000), line("token_usage_record", { usage: tokens(100, 60, 10, 20) })].join("\n"));
  expect(parsed.turns).toHaveLength(1);
  expect(parsed.turns[0]).toMatchObject({ sessionId: "codex:sid", input: 20, cacheRead: 60, cacheWrite: 20, output: 10, model: "gpt-6-astra" });
  expect(parsed.sessions[0]).toMatchObject({ cwd: "/work/project", project: "work/project", branch: "main" });
});

test("incremental parser carries baseline, model changes, and service tier across chunks", () => {
  const first = parseCodexTranscript([meta(), context(), usage(tokens(100, 60, 10))].join("\n"));
  const second = parseCodexTranscript([context("gpt-6-sol", { service_tier: "fast" }), usage(tokens(220, 120, 25), tokens(120, 60, 15), 2000)].join("\n"), "", first.state);
  expect(second.turns).toHaveLength(1);
  expect(second.turns[0]).toMatchObject({ model: "gpt-6-sol", input: 60, cacheRead: 60, output: 15, serviceTier: "fast" });
  expect(first.state.model).toBe("gpt-6-astra");
  expect(parseCodexTranscript(usage(tokens(100, 60, 10), tokens(100, 60, 10), 3000), "", second.state).turns).toEqual([]);
});

test("totals-only deltas, last-only fallback, malformed telemetry and explicit counter reset", () => {
  const rows = [meta(), context(), usage(tokens(100, 60, 10), null), usage(tokens(140, 80, 15), null, 2000), line("event_msg", { type: "token_count", info: null }), "{broken", line("compacted", {}), usage(tokens(10, 0, 2), tokens(10, 0, 2), 3000), usage(null, tokens(20, 10, 3), 4000)];
  const p = parseCodexTranscript(rows.join("\n"));
  expect(p.turns.map((r) => [r.input, r.cacheRead, r.output])).toEqual([[40, 60, 10], [20, 20, 5], [10, 0, 2], [10, 10, 3]]);
  expect(parseCodexTranscript([meta(), usage(tokens(10, 100, 2))].join("\n")).turns[0]).toMatchObject({ input: 0, cacheRead: 10, model: "codex-unknown" });
});

test("child-owned ordinal is authoritative, even when the prefix arrives in an earlier chunk", () => {
  const first = parseCodexTranscript([meta({ source: { subagent: { thread_spawn: {} } }, subagent_history_start_ordinal: 10 }), context(), usage(tokens(1000, 500, 100), null, 1000, 9)].join("\n"));
  expect(first.turns).toEqual([]);
  const second = parseCodexTranscript(usage(tokens(1100, 560, 110), tokens(100, 60, 10), 2000, 10), "", first.state);
  expect(second.turns[0]).toMatchObject({ input: 40, cacheRead: 60, output: 10, subagent: true, agentId: "codex:sid" });
  const fork = parseCodexTranscript([meta({ forked_from_id: "parent" }), context(), usage(tokens(1000, 500, 100), null, -1000), usage(tokens(1100, 560, 110), null, 1000)].join("\n"));
  expect(fork.turns).toHaveLength(1);
  expect(fork.turns[0]?.input).toBe(40);
});

test("default sources include native and archived Codex history; explicit sources stay explicit", () => {
  expect(loadConfig({}, "/home/test").sources.slice(-2)).toEqual(["/home/test/.codex/sessions", "/home/test/.codex/archived_sessions"]);
  expect(loadConfig({ CODEX_HOME: "/custom" }, "/home/test").sources.slice(-2)).toEqual(["/custom/sessions", "/custom/archived_sessions"]);
  expect(loadConfig({ USAGE_SOURCES: "/only" }, "/home/test").sources).toEqual(["/only"]);
});

test("scan resumes after restart, settles incomplete lines, deduplicates archives and shares history", async () => {
  const dir = await temp();
  const path = join(dir, "sessions/rollout-sid.jsonl");
  const db = join(dir, "usage.db");
  const initial = [meta(), context(), usage(tokens(100, 60, 10))].join("\n") + "\n";
  await Bun.write(path, initial);
  let store = new Store(db);
  await scanSources(store, [join(dir, "sessions")]);
  store.close(); store = new Store(db);
  try {
    const next = usage(tokens(220, 120, 25), tokens(120, 60, 15), 2000);
    await appendFile(path, next.slice(0, -3));
    await scanSources(store, [join(dir, "sessions")]);
    expect(store.counts().turns).toBe(1);
    await appendFile(path, next.slice(-3));
    await scanSources(store, [join(dir, "sessions")]); // Complete but no newline, still waiting to settle.
    expect(store.counts().turns).toBe(1);
    const future = Date.now() + 20000;
    await scanSources(store, [join(dir, "sessions")], { now: () => future });
    expect(store.counts().turns).toBe(2);
    await Bun.write(join(dir, "archived_sessions/copy.jsonl"), initial + next + "\n");
    await scanSources(store, [join(dir, "sessions"), join(dir, "archived_sessions")]);
    expect(store.counts().turns).toBe(2);
    const objects = memoryObjectStore();
    const sender = new Shared({ store, objects, machine: "source", now: () => future });
    await sender.sync(true);
    const remote = new Store(":memory:");
    try {
      await new Shared({ store: remote, objects, machine: "dashboard", now: () => future }).sync(true);
      const stats = summary(remote, { pricing: testCatalog, range: "all", tz: "UTC", now: NOW + 3000 });
      expect(stats.totals.tokens).toBe(245);
      expect(stats.byModel[0]?.model).toBe("gpt-6-astra");
      expect(stats.totals.cost).toBeCloseTo((100 * 10 + 120 * 1 + 25 * 50) / 1e6);
      expect(stats.byProject[0]?.project).toBe("work/project");
    } finally { remote.close(); }
  } finally { store.close(); }
});

test("older cache schema upgrades without losing Claude rows, and peer exports retain Fast pricing", async () => {
  const dir = await temp();
  const path = join(dir, "old.db");
  const { Database } = await import("bun:sqlite");
  const old = new Database(path);
  old.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, machine TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL, ts INTEGER NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, tool TEXT, message_id TEXT NOT NULL DEFAULT '', subagent INTEGER NOT NULL DEFAULT 0, agent_id TEXT);
    INSERT INTO turns(machine,session_id,ts,model,input,output,cache_read,cache_write,message_id) VALUES ('','claude',1,'claude-sonnet-5',1,1,0,0,'claude-message');`);
  old.close();
  const store = new Store(path);
  const peer = new Store(":memory:");
  try {
    expect(store.counts().turns).toBe(1);
    const parsed = parseCodexTranscript([meta(), context("gpt-6-astra", { service_tier: "fast" }), usage(tokens(100, 60, 10))].join("\n"));
    store.write(parsed, { path: "fixture", source: "fixture", size: 1, mtime: 1, offset: 1 });
    peer.import("source", store.exportSince(0));
    expect(peer.turnsBetween(NOW, NOW + 2000)[0]?.service_tier).toBe("fast");
    const stats = summary(peer, { pricing: testCatalog, range: "all", models: ["gpt-6-astra"], tz: "UTC", now: NOW + 2000 });
    expect(stats.totals.tokens).toBe(110);
    expect(stats.totals.cost).toBeCloseTo((40 * 10 + 60 + 10 * 50) * 2 / 1e6);
    const mixed = summary(peer, { pricing: testCatalog, range: "all", tz: "UTC", now: NOW + 2000 });
    expect(mixed.totals.tokens).toBe(112);
    expect(mixed.models).toHaveLength(2);
  } finally { store.close(); peer.close(); }
});
