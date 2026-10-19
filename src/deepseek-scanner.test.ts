import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeepseekSession, scanDeepseekSessions, sessionIdFromPath } from "./deepseek-scanner.ts";
import { Store } from "./store.ts";

const SID = "session-1111";
const line = (o: unknown) => JSON.stringify(o);
const session = (cwd = "/home/me/work/app", extra: Record<string, unknown> = {}) => line({ type: "session", version: 4, id: SID, createdAt: 1_000, cwd, delegationDepth: 0, ...extra });
const title = (text: string, time = 1_100) => line({ type: "session/title", time, data: { title: text } });
const assistant = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  line({
    type: "assistant/message",
    seq: 2,
    time: 1_200,
    data: {
      message: { id, role: "assistant", source: { kind: "model", provider: "deepseek-account", model: "deepseek-flash" }, content: [{ type: "tool-call", name: "bash" }] },
      usage,
      ...extra,
    },
  });

const compressed = (text: string): Uint8Array => Bun.zstdCompressSync(new TextEncoder().encode(text));

describe("parseDeepseekSession", () => {
  test("reads the session, its last title and each assistant step's four token kinds", () => {
    const text = [
      session(),
      title("first", 1_050),
      assistant("m1", { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 4 }),
      title("final"),
    ].join("\n");
    const p = parseDeepseekSession(text, `/x/${SID}/session.v4.jsonl.zstd`);
    expect(p.turns).toHaveLength(1);
    expect(p.turns[0]).toMatchObject({
      sessionId: SID,
      ts: 1_200,
      model: "deepseek-flash",
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 4,
      tool: "bash",
      messageId: "m1",
      subagent: false,
      agentId: null,
    });
    expect(p.sessions).toEqual([{ sessionId: SID, cwd: "/home/me/work/app", project: "work/app", branch: "", firstTs: 1_000, lastTs: 1_200, topic: "final", topicCustom: false }]);
  });

  test("skips empty steps, broken lines and a session without a timestamp", () => {
    const text = [
      "{not json",
      session(),
      assistant("m0", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      line({ type: "assistant/message", data: { message: { id: "m1" }, usage: { inputTokens: 5 } } }),
      line({ type: "unknown" }),
    ].join("\n");
    const p = parseDeepseekSession(text, `/x/${SID}/session.v4.jsonl.zstd`);
    expect(p.turns).toHaveLength(0);
  });

  test("a delegated session's steps are marked as subagent work", () => {
    const text = [session("/home/me/work/app", { delegationDepth: 1 }), assistant("m1", { inputTokens: 1, outputTokens: 1 })].join("\n");
    const p = parseDeepseekSession(text, `/x/${SID}/session.v4.jsonl.zstd`);
    expect(p.turns[0]).toMatchObject({ subagent: true, agentId: SID });
  });

  test("concatenated zstd frames (an appended log) decode as one file", async () => {
    const first = compressed([session(), assistant("m1", { inputTokens: 1, outputTokens: 1 })].join("\n") + "\n");
    const second = compressed(assistant("m2", { inputTokens: 2, outputTokens: 2 }) + "\n");
    const bytes = new Uint8Array(first.length + second.length);
    bytes.set(first);
    bytes.set(second, first.length);
    const p = parseDeepseekSession(new TextDecoder().decode(Bun.zstdDecompressSync(bytes)), `/x/${SID}/session.v4.jsonl.zstd`);
    expect(p.turns.map((t) => t.messageId)).toEqual(["m1", "m2"]);
  });

  test("takes the session id from the log path when the session event is missing", () => {
    const text = assistant("m1", { inputTokens: 1, outputTokens: 1 });
    expect(sessionIdFromPath(`/p/session-abc/session.v4.jsonl.zstd`)).toBe("session-abc");
    expect(parseDeepseekSession(text, `/p/session-abc/session.v4.jsonl.zstd`).turns[0]?.sessionId).toBe("session-abc");
  });
});

describe("scanDeepseekSessions", () => {
  test("reads compressed logs once, then only changed files; plain JSONL works too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-usage-"));
    const nested = join(dir, "-home-me-app");
    await mkdir(join(nested, SID), { recursive: true });
    const zst = join(nested, SID, "session.v4.jsonl.zstd");
    const plain = join(nested, "session-2222", "session.v4.jsonl");
    await mkdir(join(nested, "session-2222"), { recursive: true });
    await writeFile(zst, compressed([session(), title("zstd"), assistant("m1", { inputTokens: 2, outputTokens: 5 })].join("\n") + "\n"));
    await writeFile(plain, [session("/home/me/other", { id: "session-2222" }), assistant("m2", { inputTokens: 1, outputTokens: 1 })].join("\n") + "\n");
    const store = new Store(":memory:");

    const first = await scanDeepseekSessions(store, dir);
    expect(first).toMatchObject({ dir, files: 2, newFiles: 2, updatedFiles: 0, turns: 2, sessions: 2, error: null });
    expect(store.counts()).toMatchObject({ files: 2, turns: 2, sessions: 2 });

    const again = await scanDeepseekSessions(store, dir);
    expect(again).toMatchObject({ files: 2, newFiles: 0, updatedFiles: 0, turns: 0 });

    // A changed compressed log is parsed whole again; message ids keep the count exact.
    await writeFile(zst, compressed([session(), title("zstd"), assistant("m1", { inputTokens: 2, outputTokens: 5 }), assistant("m3", { inputTokens: 3, outputTokens: 3 })].join("\n") + "\n"));
    const changed = await scanDeepseekSessions(store, dir);
    expect(changed).toMatchObject({ updatedFiles: 1, turns: 2 });
    expect(store.counts()).toMatchObject({ turns: 3, sessions: 2 });
    store.close();
  });

  test("a broken compressed file is reported and retried, and a missing directory is skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-broken-"));
    const file = join(dir, SID, "session.v4.jsonl.zstd");
    await mkdir(join(dir, SID), { recursive: true });
    await writeFile(file, new Uint8Array([1, 2, 3, 4]));
    const store = new Store(":memory:");
    const broken = await scanDeepseekSessions(store, dir);
    expect(broken.turns).toBe(0);
    expect(broken.error).toContain(file);
    expect(store.counts().files).toBe(0);

    await writeFile(file, compressed([session(), assistant("m1", { inputTokens: 1, outputTokens: 1 })].join("\n") + "\n"));
    expect(await scanDeepseekSessions(store, dir)).toMatchObject({ newFiles: 1, turns: 1, error: null });
    expect(await scanDeepseekSessions(store, join(dir, "missing"))).toMatchObject({ files: 0, turns: 0, error: null });
    store.close();
  });
});
