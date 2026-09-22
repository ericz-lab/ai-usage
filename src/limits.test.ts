import { describe, expect, test } from "bun:test";
import { type Credentials, Limits, USAGE_URL, parseLimits } from "./limits.ts";
import { memoryObjectStore } from "./shared.ts";

const NOW = Date.parse("2026-09-23T10:00:00Z");
const BODY = {
  five_hour: { utilization: 13, resets_at: "2026-09-23T12:40:00+00:00" },
  seven_day: { utilization: 3, resets_at: "2026-09-29T13:00:00+00:00" },
  limits: [
    { kind: "session", group: "session", percent: 13, severity: "normal", resets_at: "2026-09-23T12:40:00+00:00", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 3, severity: "normal", resets_at: "2026-09-29T13:00:00+00:00", scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 4, severity: "normal", resets_at: "2026-09-29T12:59:59+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null } },
  ],
};
const creds = (over: Partial<Credentials> = {}): Credentials => ({ token: "tok", expiresAt: NOW + 3_600_000, plan: "max", tier: "default_claude_max_20x", account: "acct-1", ...over });

function scripted(body: unknown = BODY, status = 200) {
  const calls: { url: string; auth: string | null }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("parseLimits", () => {
  test("the limits array, scoped labels, reset times", () => {
    const l = parseLimits(BODY);
    expect(l.map((x) => [x.kind, x.group, x.label, x.percent])).toEqual([
      ["session", "session", null, 13],
      ["weekly_all", "weekly", null, 3],
      ["weekly_scoped", "weekly", "Fable", 4],
    ]);
    expect(l[0]!.resetsAt).toBe(Date.parse("2026-09-23T12:40:00Z"));
  });
  test("falls back to the windows when there is no limits array", () => {
    const l = parseLimits({ five_hour: BODY.five_hour, seven_day: BODY.seven_day, seven_day_opus: null });
    expect(l.map((x) => [x.kind, x.percent])).toEqual([
      ["session", 13],
      ["weekly_all", 3],
    ]);
    expect(parseLimits(null)).toEqual([]);
  });
});

describe("Limits", () => {
  test("fetches with the CLI token, publishes, and throttles", async () => {
    let clock = NOW;
    const objects = memoryObjectStore();
    const { f, calls } = scripted();
    const lim = new Limits({ machine: "david", objects, publishOnly: true, credentials: async () => creds(), fetch: f, now: () => clock });
    await lim.tick();
    expect(calls).toEqual([{ url: USAGE_URL, auth: "Bearer tok" }]);
    expect(lim.state()).toMatchObject({ ok: true, fetchedAt: NOW });
    const pub = JSON.parse(objects.objects.get("david/limits.json")!);
    expect(pub).toMatchObject({ machine: "david", account: "acct-1", plan: "max", fetchedAt: NOW });
    expect(pub.limits).toHaveLength(3);

    clock += 60_000;
    await lim.tick();
    expect(calls).toHaveLength(1); // not due
    await lim.tick(true);
    expect(calls).toHaveLength(2); // forced, over 30 s since the last attempt
    await lim.tick(true);
    expect(calls).toHaveLength(2); // forced again right away: held back
    clock += 5 * 60_000;
    await lim.tick();
    expect(calls).toHaveLength(3);
  });

  test("an expired token or a missing login is reported, not fetched", async () => {
    const { f, calls } = scripted();
    const expired = new Limits({ machine: "seoul", credentials: async () => creds({ expiresAt: NOW - 1 }), fetch: f, now: () => NOW });
    await expired.tick();
    expect(expired.state()).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
    const none = new Limits({ machine: "laptop", credentials: async () => null, fetch: f, now: () => NOW });
    await none.tick();
    expect(none.state().error).toContain("no Claude subscription login");
    expect(calls).toHaveLength(0);
    expect(await none.snapshots()).toEqual([]);
  });

  test("an error answer keeps the last good snapshot", async () => {
    let clock = NOW;
    let status = 200;
    const f = (async () => new Response(JSON.stringify(status === 200 ? BODY : { error: {} }), { status })) as unknown as typeof fetch;
    const lim = new Limits({ machine: "a", credentials: async () => creds(), fetch: f, now: () => clock });
    await lim.tick();
    status = 429;
    clock += 10 * 60_000;
    await lim.tick();
    expect(lim.state()).toMatchObject({ ok: false, error: "usage endpoint answered 429", fetchedAt: NOW });
    expect((await lim.snapshots())[0]!.fetchedAt).toBe(NOW);
  });

  test("the dashboard keeps the newest reading per account", async () => {
    const clock = NOW;
    const objects = memoryObjectStore();
    objects.objects.set("david/limits.json", JSON.stringify({ machine: "david", account: "acct-1", plan: "max", tier: null, fetchedAt: NOW - 60_000, limits: parseLimits(BODY) }));
    objects.objects.set("other/limits.json", JSON.stringify({ machine: "other", account: "acct-2", plan: "pro", tier: null, fetchedAt: NOW - 120_000, limits: parseLimits(BODY) }));
    objects.objects.set("broken/limits.json", "{");
    const stale = new Limits({ machine: "seoul", objects, others: () => ["david", "other", "broken", "gone"], credentials: async () => creds({ expiresAt: NOW - 1 }), now: () => clock });
    await stale.tick();
    const snaps = await stale.snapshots();
    expect(snaps.map((s) => [s.machine, s.account])).toEqual([
      ["david", "acct-1"],
      ["other", "acct-2"],
    ]);

    // A fresher local reading of the same account wins over the published one.
    const { f } = scripted();
    const fresh = new Limits({ machine: "seoul", objects, others: () => ["david"], credentials: async () => creds(), fetch: f, now: () => clock });
    await fresh.tick();
    expect((await fresh.snapshots()).map((s) => s.machine)).toEqual(["seoul"]);
  });
});
