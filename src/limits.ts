import { homedir } from "node:os";
import { join } from "node:path";
import type { ObjectStore } from "./shared.ts";

/**
 * Plan usage limits: the bars Claude Code's /usage shows (current session,
 * weekly all models, weekly per model), read from the endpoint the CLI itself
 * calls, with the CLI's own OAuth login on this machine.
 *
 *   GET https://api.anthropic.com/api/oauth/usage
 *       Authorization: Bearer <claudeAiOauth.accessToken>, anthropic-beta: oauth-2025-04-20
 *
 * The token is read, never refreshed: refreshing rotates the CLI's refresh
 * token behind its back. A machine whose CLI has not run lately has an expired
 * token and simply reports that; another machine on the same account fills in.
 *
 * With the shared store each machine publishes its snapshot as
 * `<machine>/limits.json` (outside the manifest, so pull ignores it), and the
 * dashboard reads every known machine's file and keeps the newest per account.
 */

export type Limit = {
  /** session, weekly_all, weekly_scoped, ... as the endpoint names them. */
  kind: string;
  /** session or weekly. */
  group: string;
  /** The model a scoped limit covers ("Fable"), else null. */
  label: string | null;
  percent: number;
  resetsAt: number | null;
  /** normal, warning, critical, ... as the endpoint names them. */
  severity: string;
};

export type LimitsSnapshot = {
  machine: string;
  /** accountUuid from the CLI's ~/.claude.json; the key two machines on one account share. */
  account: string | null;
  plan: string | null;
  tier: string | null;
  fetchedAt: number;
  limits: Limit[];
};

export type LimitsState = { ok: boolean; error: string | null; fetchedAt: number | null; attemptedAt: number | null };

export type Credentials = { token: string; expiresAt: number | null; plan: string | null; tier: string | null; account: string | null };

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const readJson = async (path: string): Promise<Record<string, unknown> | null> => {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** The CLI's login: `.credentials.json` in its config directory, else (macOS) the login keychain. null = no subscription login here. */
export async function readCredentials(env: Record<string, string | undefined> = process.env, home = homedir()): Promise<Credentials | null> {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  let creds = await readJson(join(dir, ".credentials.json"));
  if (!creds && process.platform === "darwin") {
    const r = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], { stderr: "ignore" });
    if (r.exitCode === 0)
      try {
        creds = JSON.parse(r.stdout.toString()) as Record<string, unknown>;
      } catch {
        creds = null;
      }
  }
  const o = creds?.claudeAiOauth as Record<string, unknown> | undefined;
  if (!o || typeof o.accessToken !== "string" || !o.accessToken) return null;
  const profile = (await readJson(join(dir, ".claude.json"))) ?? (await readJson(join(home, ".claude.json")));
  const account = (profile?.oauthAccount as Record<string, unknown> | undefined)?.accountUuid;
  return {
    token: o.accessToken,
    expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : null,
    plan: typeof o.subscriptionType === "string" ? o.subscriptionType : null,
    tier: typeof o.rateLimitTier === "string" ? o.rateLimitTier : null,
    account: typeof account === "string" ? account : null,
  };
}

const ts = (v: unknown): number | null => {
  if (typeof v !== "string" || !v) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

/** The endpoint's body -> limits. `limits` when present; else the older five_hour / seven_day / seven_day_<model> windows. */
export function parseLimits(body: unknown): Limit[] {
  const b = (body ?? {}) as Record<string, unknown>;
  if (Array.isArray(b.limits))
    return b.limits
      .filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null && typeof l.percent === "number")
      .map((l) => {
        const scope = l.scope as { model?: { display_name?: unknown } } | null;
        const label = scope?.model?.display_name;
        return {
          kind: String(l.kind ?? ""),
          group: String(l.group ?? (l.kind === "session" ? "session" : "weekly")),
          label: typeof label === "string" ? label : null,
          percent: l.percent as number,
          resetsAt: ts(l.resets_at),
          severity: String(l.severity ?? "normal"),
        };
      });
  const out: Limit[] = [];
  const win = (key: string, kind: string, group: string, label: string | null) => {
    const w = b[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (w && typeof w.utilization === "number") out.push({ kind, group, label, percent: w.utilization, resetsAt: ts(w.resets_at), severity: "normal" });
  };
  win("five_hour", "session", "session", null);
  win("seven_day", "weekly_all", "weekly", null);
  win("seven_day_opus", "weekly_scoped", "weekly", "Opus");
  win("seven_day_sonnet", "weekly_scoped", "weekly", "Sonnet");
  return out;
}

export type LimitsOptions = {
  machine: string;
  /** The shared store; without it the snapshot stays local. */
  objects?: ObjectStore;
  /** Names of the other machines in the shared store. */
  others?: () => string[];
  /** A collector publishes its snapshot and never reads the others'. */
  publishOnly?: boolean;
  /** Minimum time between fetches from the endpoint. */
  intervalMs?: number;
  credentials?: () => Promise<Credentials | null>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
};

const FORCED_MIN_MS = 30_000;
const REMOTE_TTL_MS = 60_000;
const KEY = "limits.json";

export class Limits {
  private readonly opts: LimitsOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly intervalMs: number;
  private local: LimitsSnapshot | null = null;
  private st: LimitsState = { ok: false, error: null, fetchedAt: null, attemptedAt: null };
  private inflight: Promise<void> | null = null;
  private remote: { at: number; snaps: LimitsSnapshot[] } | null = null;

  constructor(opts: LimitsOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.intervalMs = opts.intervalMs ?? 5 * 60_000;
  }

  state(): LimitsState {
    return { ...this.st };
  }

  /** Fetch this machine's limits when due (forced: when the last attempt is over 30 s old), then publish them. Never throws. */
  tick(force = false): Promise<void> {
    const since = this.now() - (this.st.attemptedAt ?? 0);
    if (since < (force ? FORCED_MIN_MS : this.intervalMs)) return Promise.resolve();
    if (!this.inflight)
      this.inflight = this.fetchOwn().finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchOwn(): Promise<void> {
    this.st.attemptedAt = this.now();
    const fail = (error: string) => {
      if (error !== this.st.error) this.log(`limits: ${error}`);
      this.st = { ...this.st, ok: false, error };
    };
    let creds: Credentials | null;
    try {
      creds = await (this.opts.credentials ?? (() => readCredentials()))();
    } catch (e) {
      return fail(`credentials unreadable: ${(e as Error).message}`);
    }
    if (!creds) return fail("no Claude subscription login on this machine");
    if (creds.expiresAt !== null && creds.expiresAt <= this.now()) return fail("the CLI's token has expired; it renews the next time claude runs here");
    let body: unknown;
    try {
      const r = await (this.opts.fetch ?? fetch)(USAGE_URL, {
        headers: { authorization: `Bearer ${creds.token}`, "anthropic-beta": "oauth-2025-04-20", accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return fail(`usage endpoint answered ${r.status}`);
      body = await r.json();
    } catch (e) {
      return fail(`usage endpoint unreachable: ${(e as Error).message}`);
    }
    const limits = parseLimits(body);
    if (!limits.length) return fail("usage endpoint returned no limits");
    this.local = { machine: this.opts.machine, account: creds.account, plan: creds.plan, tier: creds.tier, fetchedAt: this.now(), limits };
    if (!this.st.ok) this.log(`limits: reading plan usage (${creds.plan ?? "plan"})`);
    this.st = { ok: true, error: null, fetchedAt: this.local.fetchedAt, attemptedAt: this.st.attemptedAt };
    if (this.opts.objects)
      try {
        await this.opts.objects.put(`${this.opts.machine}/${KEY}`, JSON.stringify(this.local));
      } catch (e) {
        this.log(`limits: publish failed: ${(e as Error).message}`);
      }
  }

  /** The newest snapshot per account, this machine's and (unless publish-only) every other machine's in the shared store. */
  async snapshots(): Promise<LimitsSnapshot[]> {
    const all: LimitsSnapshot[] = this.local ? [this.local] : [];
    if (this.opts.objects && !this.opts.publishOnly) all.push(...(await this.readRemote()));
    const best = new Map<string, LimitsSnapshot>();
    for (const s of all) {
      const k = s.account ?? `machine:${s.machine}`;
      const cur = best.get(k);
      if (!cur || s.fetchedAt > cur.fetchedAt) best.set(k, s);
    }
    return [...best.values()].sort((a, b) => b.fetchedAt - a.fetchedAt);
  }

  private async readRemote(): Promise<LimitsSnapshot[]> {
    if (this.remote && this.now() - this.remote.at < REMOTE_TTL_MS) return this.remote.snaps;
    const names = (this.opts.others?.() ?? []).filter((n) => n !== this.opts.machine);
    const snaps = (
      await Promise.all(
        names.map(async (n) => {
          try {
            const text = await this.opts.objects!.get(`${n}/${KEY}`);
            if (!text) return null;
            const s = JSON.parse(text) as LimitsSnapshot;
            return Array.isArray(s.limits) && typeof s.fetchedAt === "number" ? { ...s, machine: n } : null;
          } catch {
            return null;
          }
        }),
      )
    ).filter((s): s is LimitsSnapshot => s !== null);
    this.remote = { at: this.now(), snaps };
    return snaps;
  }
}
