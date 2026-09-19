import { describe, expect, test } from "bun:test";
import { Shared, memoryObjectStore, objectStoreFromEnv } from "./shared.ts";
import { Store } from "./store.ts";

const H = 3_600_000;
const NOW = Date.parse("2026-09-19T10:00:00Z");
const turn = (id: string, ts: number, sessionId = "s1") => ({ sessionId, ts, model: "claude-sonnet-5", input: 10, output: 1, cacheRead: 0, cacheWrite: 0, tool: null, messageId: id, subagent: false, agentId: null });
const session = (id: string) => ({ sessionId: id, cwd: "/w/app", project: "w/app", branch: "main", firstTs: NOW - 2 * H, lastTs: NOW - H, topic: null, topicCustom: false });
const file = { path: "/p", source: "/", size: 1, mtime: 1, offset: 1 };

describe("shared store", () => {
  test("publishes only changed files, pulls the other machine's rows once, resumes on change", async () => {
    const objects = memoryObjectStore();
    const a = new Store(":memory:");
    const b = new Store(":memory:");
    a.write({ sessions: [session("s1")], turns: [turn("a1", NOW - H), turn("a2", NOW - 30 * H)], dispatches: [] }, file);
    b.write({ sessions: [session("s2")], turns: [turn("b1", NOW - H, "s2")], dispatches: [] }, file);
    let clock = NOW;
    const sa = new Shared({ store: a, objects, machine: "alpha", now: () => clock, intervalMs: 1000 });
    const sb = new Shared({ store: b, objects, machine: "beta", now: () => clock });

    const r1 = await sa.sync();
    expect(r1.skipped).toBe(false);
    expect(r1.published.sort()).toEqual(["agents.jsonl", "sessions.jsonl", "turns/2026-09-18.jsonl", "turns/2026-09-19.jsonl"]);
    expect(r1.pulled).toEqual([]); // beta has published nothing yet
    expect([...objects.objects.keys()].sort()).toEqual(["alpha/agents.jsonl", "alpha/manifest.json", "alpha/sessions.jsonl", "alpha/turns/2026-09-18.jsonl", "alpha/turns/2026-09-19.jsonl"]);

    const r2 = await sb.sync();
    expect(r2.published).toHaveLength(3);
    expect(r2.pulled).toEqual([{ name: "alpha", updatedAt: NOW, pulledAt: NOW, ok: true, error: null, rows: 3 }]);
    expect(b.machines()).toEqual([
      { machine: "", turns: 1 },
      { machine: "alpha", turns: 2 },
    ]);
    expect(b.sessionsSince(0).find((s) => s.session_id === "s1")?.machine).toBe("alpha");
    // beta's own export still holds only its rows.
    expect(b.exportSince(0).turns.map((t) => t.message_id)).toEqual(["b1"]);

    // Within the interval a sync is skipped; forced, alpha now pulls beta and publishes nothing new.
    clock += 500;
    expect((await sa.sync()).skipped).toBe(true);
    const r3 = await sa.sync(true);
    expect(r3.published).toEqual([]);
    expect(r3.pulled).toEqual([{ name: "beta", updatedAt: NOW, pulledAt: clock, ok: true, error: null, rows: 2 }]);
    expect(a.machines()).toEqual([
      { machine: "", turns: 2 },
      { machine: "beta", turns: 1 },
    ]);

    // A new turn today on alpha: only today's file and the manifest are rewritten; beta pulls just that file.
    clock += 2000;
    a.write({ sessions: [], turns: [turn("a3", NOW)], dispatches: [] }, file);
    expect((await sa.sync()).published).toEqual(["turns/2026-09-19.jsonl"]);
    const r4 = await sb.sync(true);
    expect(r4.pulled[0]).toMatchObject({ name: "alpha", rows: 2, updatedAt: clock });
    expect(b.machines().find((m) => m.machine === "alpha")?.turns).toBe(3);
    // Nothing changed since: a pull imports nothing and reports zero rows.
    expect((await sb.sync(true)).pulled[0]?.rows).toBe(0);
    // The same store under a new machine name publishes everything again into its new directory.
    const renamed = new Shared({ store: a, objects, machine: "alpha2", now: () => clock });
    expect((await renamed.sync(true)).published).toHaveLength(4);
    expect([...objects.objects.keys()].filter((k) => k.startsWith("alpha2/"))).toHaveLength(5);
    a.close();
    b.close();
  });

  test("a broken manifest is reported for that machine and does not stop the others", async () => {
    const objects = memoryObjectStore();
    objects.objects.set("bad/manifest.json", "{not json");
    objects.objects.set("gone/manifest.json", JSON.stringify({ machine: "gone", updatedAt: 1, files: { "sessions.jsonl": { hash: "x", rows: 1 } } }));
    objects.objects.set("ok/manifest.json", JSON.stringify({ machine: "ok", updatedAt: 5, files: { "turns/2026-09-19.jsonl": { hash: "h", rows: 1 } } }));
    objects.objects.set("ok/turns/2026-09-19.jsonl", JSON.stringify({ machine: "", session_id: "z", ts: NOW, model: "claude-haiku-4-5", input: 1, output: 1, cache_read: 0, cache_write: 0, tool: null, message_id: "z1", subagent: 0, agent_id: null }) + "\n");
    objects.objects.set("weird name/manifest.json", "{}");
    const store = new Store(":memory:");
    const s = new Shared({ store, objects, machine: "me", now: () => NOW });
    const r = await s.sync();
    expect(r.pulled.map((m) => [m.name, m.ok, m.rows])).toEqual([
      ["bad", false, 0],
      ["gone", false, 0],
      ["ok", true, 1],
    ]);
    expect(r.pulled[0]?.error).toBe("manifest unreadable");
    expect(r.pulled[1]?.error).toMatch(/missing/);
    expect(store.machines()).toEqual([{ machine: "ok", turns: 1 }]);
    expect(s.lastSyncAt()).toBe(NOW);
    // Directories that disappear are forgotten on the next pull; their rows stay.
    for (const k of [...objects.objects.keys()]) if (k.startsWith("ok/") || k.startsWith("bad/")) objects.objects.delete(k);
    expect((await s.sync(true)).pulled.map((m) => m.name)).toEqual(["gone"]);
    expect(store.machines()).toEqual([{ machine: "ok", turns: 1 }]);
    expect(() => new Shared({ store, objects, machine: "bad name" })).toThrow(/machine name/);
    store.close();
  });

  test("objectStoreFromEnv parses BLOB_URL and ignores anything but s3", () => {
    expect(objectStoreFromEnv({})).toBeNull();
    expect(objectStoreFromEnv({ BLOB_URL: "file:///data/blobs" })).toBeNull();
    expect(objectStoreFromEnv({ BLOB_URL: "s3://bucket/ai-usage", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "b", S3_ENDPOINT: "https://x" })?.url).toBe("s3://bucket/ai-usage/");
    expect(objectStoreFromEnv({ BLOB_URL: "s3://bucket/", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "b" })?.url).toBe("s3://bucket/");
  });
});
