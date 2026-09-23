import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_USAGE_URL, parseCodexLimits, readCodexCredentials } from "./codex-limits.ts";
import { Limits, type Credentials } from "./limits.ts";
import { memoryObjectStore } from "./shared.ts";

const NOW = 1_800_000_000_000;
const window = (percent: number, seconds = 18000) => ({ used_percent: percent, reset_at: NOW / 1000 + 3600, limit_window_seconds: seconds });
const body = { plan_type: "plus", rate_limit: { primary_window: window(12), secondary_window: window(35, 604800) } };
const credentials: Credentials = { token: "fake-token", account: "account", expiresAt: NOW + 60000, plan: null, tier: null };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const jwt = (payload: unknown) => `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

test("native auth respects CODEX_HOME, extracts identity and expiry, and never rewrites credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-usage-")); dirs.push(home);
  const path = join(home, ".codex/auth.json");
  const original = JSON.stringify({ tokens: { access_token: jwt({ exp: NOW / 1000 + 60 }), id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "claim-account", chatgpt_plan_type: "pro" } }) } });
  await Bun.write(path, original);
  expect(await readCodexCredentials({}, home)).toMatchObject({ account: "claim-account", plan: "pro", expiresAt: NOW + 60000 });
  expect(await Bun.file(path).text()).toBe(original);
  expect(await readCodexCredentials({ CODEX_HOME: join(home, "isolated") }, home)).toBeNull();
  await Bun.write(join(home, "isolated/auth.json"), JSON.stringify({ tokens: { access_token: "opaque", account_id: "explicit" } }));
  expect(await readCodexCredentials({ CODEX_HOME: join(home, "isolated") }, home)).toMatchObject({ account: "explicit", expiresAt: null });
  for (const invalid of ["{", "null", JSON.stringify({ OPENAI_API_KEY: "key" }), JSON.stringify({ auth_mode: "apikey", tokens: { access_token: "old" } })]) {
    await Bun.write(path, invalid);
    expect(await readCodexCredentials({}, home)).toBeNull();
  }
});

test("parses used percentages, Unix resets, weekly-only and extra model windows", () => {
  expect(parseCodexLimits(body).map((l) => [l.group, l.percent, l.resetsAt])).toEqual([["session", 12, NOW + 3600000], ["weekly", 35, NOW + 3600000]]);
  expect(parseCodexLimits({ rate_limit: { primary_window: window(5, 604800) } })[0]?.group).toBe("weekly");
  const extra = parseCodexLimits({ ...body, additional_rate_limits: [null, {}, { limit_name: "Spark", rate_limit: { primary_window: window(80), secondary_window: window(95, 604800) } }] });
  expect(extra.slice(2).map((l) => [l.label, l.group, l.severity])).toEqual([["Spark", "session", "warning"], ["Spark", "weekly", "critical"]]);
  expect(parseCodexLimits({ rate_limit: { primary_window: { used_percent: NaN }, secondary_window: { used_percent: "5" } } })).toEqual([]);
  expect(parseCodexLimits(null)).toEqual([]);
});

test("fetches account-scoped Codex data, publishes no secrets, throttles and retains data on errors", async () => {
  let clock = NOW, status = 200, calls = 0;
  let response: unknown = body;
  const objects = memoryObjectStore();
  const fetcher = (async (url: string, init: RequestInit) => {
    calls++;
    expect(url).toBe(CODEX_USAGE_URL);
    const h = new Headers(init.headers);
    expect(h.get("authorization")).toBe("Bearer fake-token");
    expect(h.get("chatgpt-account-id")).toBe("account");
    expect(h.has("anthropic-beta")).toBe(false);
    expect(init.redirect).toBe("error");
    return new Response(JSON.stringify(response), { status });
  }) as typeof fetch;
  const limits = new Limits({ provider: "codex", machine: "local", credentials: async () => ({ ...credentials, expiresAt: null }), fetch: fetcher, objects, now: () => clock });
  await Promise.all([limits.tick(), limits.tick()]);
  expect(calls).toBe(1);
  expect(limits.state().ok).toBe(true);
  const published = objects.objects.get("local/limits-codex.json")!;
  expect(JSON.parse(published)).toMatchObject({ provider: "codex", plan: "plus", account: "account" });
  expect(published).not.toContain("fake-token");
  expect(objects.objects.has("local/limits.json")).toBe(false);
  await limits.tick(true); expect(calls).toBe(1);
  clock += 30000; await limits.tick(true); expect(calls).toBe(2);
  // Keep credentials valid to exercise the HTTP failures.
  for (const code of [401, 403, 429, 500]) {
    status = code; clock += 30000;
    const retry = new Limits({ provider: "codex", machine: "local", credentials: async () => ({ ...credentials, expiresAt: null }), fetch: fetcher, now: () => clock });
    await retry.tick(); expect(retry.state().error).toContain(String(code));
  }
  // Original instance preserves its last good reading on an empty response.
  clock = NOW + 40000; status = 200; response = {};
  await limits.tick(true); // still throttled
  clock = NOW + 60000;
  await limits.tick(true);
  expect(limits.state().error).toBe("usage endpoint returned no limits");
  expect((await limits.snapshots())[0]?.plan).toBe("plus");
});

test("missing and expired logins do not call the endpoint", async () => {
  for (const c of [null, { ...credentials, expiresAt: NOW - 1 }]) {
    const limits = new Limits({ provider: "codex", machine: "local", credentials: async () => c, now: () => NOW, fetch: (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch });
    await limits.tick();
    expect(limits.state().error).toContain(c ? "expired" : "no Codex");
    expect(await limits.snapshots()).toEqual([]);
  }
});

test("shared Codex readings deduplicate by account and remain separate from legacy Claude snapshots", async () => {
  const objects = memoryObjectStore();
  const snapshot = { machine: "ignored", account: "account", fetchedAt: NOW, plan: "plus", tier: null, limits: parseCodexLimits(body) };
  objects.objects.set("a/limits.json", JSON.stringify(snapshot));
  objects.objects.set("a/limits-codex.json", JSON.stringify({ ...snapshot, provider: "codex" }));
  objects.objects.set("b/limits-codex.json", JSON.stringify({ ...snapshot, provider: "codex", fetchedAt: NOW + 1 }));
  const options = { machine: "local", objects, others: () => ["a", "b"], now: () => NOW };
  expect((await new Limits(options).snapshots()).map((s) => s.machine)).toEqual(["a"]);
  expect((await new Limits({ ...options, provider: "codex" }).snapshots()).map((s) => s.machine)).toEqual(["b"]);
  expect(await new Limits({ ...options, provider: "codex", publishOnly: true }).snapshots()).toEqual([]);
});
