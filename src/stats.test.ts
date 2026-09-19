import { describe, expect, test } from "bun:test";
import type { Parsed } from "./scanner.ts";
import { dayKey, hourOf, startOfDay, summary, windowFor } from "./stats.ts";
import { Store } from "./store.ts";

const H = 3_600_000;
const NOW = Date.parse("2026-09-19T10:00:00Z");
const turn = (o: Partial<Parsed["turns"][number]> & { ts: number }) => ({ sessionId: "s1", model: "claude-sonnet-5", input: 100, output: 10, cacheRead: 0, cacheWrite: 0, tool: null, messageId: `m${o.ts}${o.sessionId ?? ""}`, subagent: false, agentId: null, ...o });
const session = (o: Partial<Parsed["sessions"][number]> & { sessionId: string }) => ({ cwd: "/home/me/work/app", project: "work/app", branch: "main", firstTs: NOW - 4 * H, lastTs: NOW - H, topic: null, topicCustom: false, ...o });

function seeded(): Store {
  const store = new Store(":memory:");
  store.write(
    {
      sessions: [session({ sessionId: "s1" }), session({ sessionId: "s2", cwd: "/home/me/other", project: "me/other", branch: "dev", topic: "fix it" })],
      turns: [
        turn({ ts: NOW - H }), // today, sonnet: 110 tokens
        turn({ ts: NOW - 2 * H, model: "claude-opus-5", input: 1000, output: 100, cacheRead: 5000 }), // today, opus: 6100
        turn({ ts: NOW - 30 * H, sessionId: "s2", model: "claude-haiku-4-5-20251001", input: 50, output: 50 }), // yesterday: 100
        turn({ ts: NOW - 30 * H + 1, sessionId: "s2", model: "claude-haiku-4-5-20251001", input: 5, output: 5, subagent: true, agentId: "ag1" }), // yesterday subagent: 10
        turn({ ts: NOW - 40 * 24 * H, model: "local-llm", input: 7, output: 7 }), // 40 days ago, unpriced
      ],
      dispatches: [{ agentId: "ag1", agentType: "Explore", sessionId: "s2", completedAt: NOW - 29 * H, status: "completed", totalTokens: 10, durationMs: 3000, toolUses: 2 }],
    },
    { path: "/p/x.jsonl", source: "/p", size: 1, mtime: 1, offset: 1 },
  );
  return store;
}

describe("time helpers", () => {
  test("day and hour follow the zone", () => {
    const ts = Date.parse("2026-09-19T23:30:00Z");
    expect(dayKey(ts, "UTC")).toBe("2026-09-19");
    expect(dayKey(ts, "Asia/Tokyo")).toBe("2026-09-20");
    expect(hourOf(ts, "Asia/Tokyo")).toBe(8);
    expect(hourOf(Date.parse("2026-09-19T00:10:00Z"), "UTC")).toBe(0);
    expect(startOfDay(ts, "Asia/Tokyo")).toBe(Date.parse("2026-09-19T15:00:00Z"));
    expect(startOfDay(ts, "America/New_York")).toBe(Date.parse("2026-09-19T04:00:00Z"));
    expect(windowFor("7d", NOW, "UTC").from).toBe(Date.parse("2026-09-13T00:00:00Z"));
    expect(windowFor("today", NOW, "Asia/Tokyo").from).toBe(Date.parse("2026-09-18T15:00:00Z"));
  });
});

describe("summary", () => {
  test("today: totals, models, sessions, cost", () => {
    const s = summary(seeded(), { range: "today", tz: "UTC", now: NOW });
    expect(s.totals).toMatchObject({ turns: 2, tokens: 6210, sessions: 1, days: 1, input: 1100, output: 110, cacheRead: 5000, subagentTokens: 0 });
    // sonnet: 100*3 + 10*15 = 450 µ$; opus: 1000*5 + 100*25 + 5000*0.5 = 10000 µ$
    expect(s.totals.cost).toBeCloseTo(0.01045, 6);
    expect(s.byModel.map((m) => m.model)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(s.daily).toHaveLength(1);
    expect(s.daily[0]).toMatchObject({ day: "2026-09-19", tokens: 6210, byModel: { "claude-opus-5": 6100, "claude-sonnet-5": 110 } });
    expect(s.hourly[9]?.tokens).toBe(110);
    expect(s.hourly[8]?.tokens).toBe(6100);
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0]).toMatchObject({ sessionId: "s1", project: "work/app", model: "claude-opus-5", durationMin: 180, machine: "" });
    expect(s.models.map((m) => m.model)).toContain("local-llm");
    expect(s.models.find((m) => m.model === "local-llm")?.priced).toBe(false);
  });

  test("7d: every calendar day is listed, subagents are attributed, per-day average spans the window", () => {
    const s = summary(seeded(), { range: "7d", tz: "UTC", now: NOW });
    expect(s.daily.map((d) => d.day)).toEqual(["2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"]);
    expect(s.totals).toMatchObject({ turns: 4, tokens: 6320, sessions: 2, days: 2, subagentTokens: 10, subagentTurns: 1 });
    expect(s.totals.perDay.tokens).toBe(Math.round(6320 / 7));
    expect(s.subagents).toEqual([{ type: "Explore", dispatches: 1, turns: 1, input: 5, output: 5, cacheRead: 0, cacheWrite: 0, tokens: 10, cost: 5e-6 * 1 + 5e-6 * 5 }]);
    expect(s.dispatches[0]).toMatchObject({ agentId: "ag1", type: "Explore", project: "me/other", tokens: 10, durationMs: 3000, toolUses: 2 });
    expect(s.byProject.map((p) => [p.project, p.sessions])).toEqual([
      ["work/app", 1],
      ["me/other", 1],
    ]);
    expect(s.byBranch.find((b) => b.branch === "dev")?.tokens).toBe(110);
    expect(s.hourlyDays).toBe(2);
    expect(s.sessions.find((x) => x.sessionId === "s2")).toMatchObject({ topic: "fix it", subagentTokens: 10 });
  });

  test("model filter narrows everything; an unpriced model makes the cost n/a", () => {
    const s = summary(seeded(), { range: "7d", tz: "UTC", now: NOW, models: ["claude-sonnet-5", "nope"] });
    expect(s.selected).toEqual(["claude-sonnet-5"]);
    expect(s.totals.tokens).toBe(110);
    const all = summary(seeded(), { range: "all", tz: "UTC", now: NOW });
    expect(all.totals.cost).toBeNull();
    expect(all.byModel.find((m) => m.model === "local-llm")?.cost).toBeNull();
    expect(all.byModel.find((m) => m.model === "claude-sonnet-5")?.cost).not.toBeNull();
    expect(all.daily[0]?.day).toBe("2026-08-10");
    expect(all.daily).toHaveLength(41);
  });

  test("machines: pulled rows are labelled and can be filtered", () => {
    const store = seeded();
    store.import("box2", {
      sessions: [{ machine: "", session_id: "s9", cwd: "/srv/app", project: "srv/app", branch: "", first_ts: NOW - H, last_ts: NOW - H, topic: null, topic_custom: 0 }],
      turns: [{ machine: "", session_id: "s9", ts: NOW - H, model: "claude-sonnet-5", input: 1, output: 1, cache_read: 0, cache_write: 0, tool: null, message_id: "remote1", subagent: 0, agent_id: null }],
      agents: [],
    });
    const s = summary(store, { range: "today", tz: "UTC", now: NOW });
    expect(s.machines).toEqual([
      { machine: "", turns: 5, local: true },
      { machine: "box2", turns: 1, local: false },
    ]);
    expect(s.byMachine.map((m) => [m.machine, m.tokens, m.sessions])).toEqual([
      ["", 6210, 1],
      ["box2", 2, 1],
    ]);
    expect(s.byProject.find((p) => p.machine === "box2")).toMatchObject({ project: "srv/app", tokens: 2 });
    const only = summary(store, { range: "today", tz: "UTC", now: NOW, machines: ["box2"] });
    expect(only.totals.tokens).toBe(2);
    expect(only.sessions[0]).toMatchObject({ sessionId: "s9", machine: "box2" });
    // The peer's own export never includes rows it pulled itself.
    expect(store.exportSince(0).turns.map((t) => t.message_id)).not.toContain("remote1");
    expect(store.latestTurn("box2")).toBe(NOW - H);
    store.close();
  });
});
