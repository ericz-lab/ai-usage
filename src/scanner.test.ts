import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idsFromPath, parseTranscript, projectName, scanSources } from "./scanner.ts";
import { Store } from "./store.ts";

const SID = "a4830a84-5355-42b5-b2df-498097c0f197";
const line = (o: unknown) => JSON.stringify(o);
const assistant = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", sessionId: SID, timestamp: "2026-09-09T16:20:12.000Z", cwd: "/home/me/work/app", gitBranch: "main", isSidechain: false, message: { model: "claude-sonnet-5", id, usage, content: [{ type: "tool_use", name: "Read" }] }, ...extra });
const user = (ts: string, extra: Record<string, unknown> = {}) => line({ type: "user", sessionId: SID, timestamp: ts, cwd: "/home/me/work/app", gitBranch: "main", message: { role: "user", content: "hi" }, ...extra });

describe("parseTranscript", () => {
  test("keeps the last record of a streamed message and sums nothing twice", () => {
    const text = [user("2026-09-09T16:20:10.000Z"), assistant("msg_1", { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 }), assistant("msg_1", { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 40 })].join("\n");
    const p = parseTranscript(text, `/x/${SID}.jsonl`);
    expect(p.turns).toHaveLength(1);
    expect(p.turns[0]).toMatchObject({ sessionId: SID, model: "claude-sonnet-5", input: 2, cacheWrite: 10, cacheRead: 0, output: 40, tool: "Read", messageId: "msg_1", subagent: false, agentId: null });
    expect(p.sessions).toHaveLength(1);
    expect(p.sessions[0]).toMatchObject({ sessionId: SID, cwd: "/home/me/work/app", project: "work/app", branch: "main", firstTs: Date.parse("2026-09-09T16:20:10.000Z"), lastTs: Date.parse("2026-09-09T16:20:12.000Z") });
  });

  test("skips zero-usage responses, broken lines and records without a timestamp", () => {
    const text = ["{not json", assistant("msg_0", { input_tokens: 0, output_tokens: 0 }), line({ type: "assistant", sessionId: SID, message: { model: "m", id: "x", usage: { input_tokens: 5 } } }), line({ type: "attachment", sessionId: SID, attachment: { type: "x" } })].join("\n");
    expect(parseTranscript(text).turns).toHaveLength(0);
  });

  test("titles: a custom title wins over an ai title whatever the order", () => {
    const a = [line({ type: "ai-title", aiTitle: "guessed", sessionId: SID }), line({ type: "custom-title", customTitle: "mine", sessionId: SID }), line({ type: "ai-title", aiTitle: "guessed again", sessionId: SID })].join("\n");
    expect(parseTranscript(a).sessions[0]).toMatchObject({ topic: "mine", topicCustom: true, firstTs: 0 });
    const b = [line({ type: "ai-title", aiTitle: "guessed", sessionId: SID })].join("\n");
    expect(parseTranscript(b).sessions[0]).toMatchObject({ topic: "guessed", topicCustom: false });
  });

  test("subagents: sidechain flag, agentId or the subagents directory; dispatches from toolUseResult", () => {
    const sub = parseTranscript(assistant("msg_s", { input_tokens: 3, output_tokens: 3 }, { isSidechain: true, agentId: "abc123" }));
    expect(sub.turns[0]).toMatchObject({ subagent: true, agentId: "abc123" });
    const byPath = parseTranscript(assistant("msg_p", { input_tokens: 3, output_tokens: 3 }), `/p/${SID}/subagents/agent-deadbeef.jsonl`);
    expect(byPath.turns[0]).toMatchObject({ subagent: true, agentId: "deadbeef" });
    const parent = parseTranscript(user("2026-09-09T16:30:00.000Z", { toolUseResult: { agentId: "abc123", agentType: "Explore", status: "completed", totalTokens: 1234, totalDurationMs: 5000, totalToolUseCount: 7, content: [] } }));
    expect(parent.dispatches).toEqual([{ agentId: "abc123", agentType: "Explore", sessionId: SID, completedAt: Date.parse("2026-09-09T16:30:00.000Z"), status: "completed", totalTokens: 1234, durationMs: 5000, toolUses: 7 }]);
  });

  test("a record without a session id takes it from the file name", () => {
    const p = parseTranscript(line({ type: "assistant", timestamp: "2026-09-09T16:20:12.000Z", message: { model: "m", usage: { input_tokens: 1 } } }), `/p/${SID}.jsonl`);
    expect(p.turns[0]?.sessionId).toBe(SID);
    expect(p.turns[0]?.messageId).toBe("");
  });
});

test("projectName and idsFromPath", () => {
  expect(projectName("/home/me/work/app")).toBe("work/app");
  expect(projectName("C:\\Users\\me\\app\\")).toBe("me/app");
  expect(projectName("")).toBe("unknown");
  expect(idsFromPath(`/p/-home-me/${SID}.jsonl`)).toEqual({ sessionId: SID, agentId: null });
  expect(idsFromPath(`/p/-home-me/${SID}/subagents/agent-a1.jsonl`)).toEqual({ sessionId: SID, agentId: "a1" });
});

describe("scanSources", () => {
  test("reads new files, then only what was appended; a missing source is skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-"));
    const proj = join(dir, "-home-me-app");
    await mkdir(proj, { recursive: true });
    const file = join(proj, `${SID}.jsonl`);
    await writeFile(file, [user("2026-09-09T16:20:10.000Z"), assistant("msg_1", { input_tokens: 2, output_tokens: 5 })].join("\n") + "\n");
    const store = new Store(":memory:");
    const r1 = await scanSources(store, [dir, join(dir, "missing")]);
    expect(r1).toMatchObject({ sources: [dir], files: 1, newFiles: 1, updatedFiles: 0, turns: 1 });
    expect(store.counts()).toMatchObject({ files: 1, turns: 1, sessions: 1 });

    // Nothing changed: nothing read.
    const r2 = await scanSources(store, [dir]);
    expect(r2).toMatchObject({ newFiles: 0, updatedFiles: 0, turns: 0 });

    // Appended: a partial last line (no newline) waits until the file settles.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, assistant("msg_2", { input_tokens: 1, output_tokens: 1 }) + "\n" + assistant("msg_3", { input_tokens: 9, output_tokens: 9 }).slice(0, 40));
    const r3 = await scanSources(store, [dir]);
    expect(r3).toMatchObject({ updatedFiles: 1, turns: 1 });
    expect(store.counts().turns).toBe(2);

    // The final usage of a message that was already stored replaces the partial one.
    await appendFile(file, assistant("msg_3", { input_tokens: 9, output_tokens: 9 }).slice(40) + "\n" + assistant("msg_2", { input_tokens: 1, output_tokens: 100 }) + "\n");
    await scanSources(store, [dir]);
    const rows = store.turnsBetween(0, Date.now());
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.message_id === "msg_2")?.output).toBe(100);

    // A file quiet for a while with no trailing newline is consumed whole.
    const file2 = join(proj, "b7c2e0a1-0000-4000-8000-000000000000.jsonl");
    await writeFile(file2, assistant("msg_4", { input_tokens: 1, output_tokens: 1 }));
    const old = (Date.now() - 60_000) / 1000;
    await utimes(file2, old, old);
    const r5 = await scanSources(store, [dir]);
    expect(r5).toMatchObject({ newFiles: 1, turns: 1 });
    expect(store.counts().turns).toBe(4);
    store.close();
  });
});
