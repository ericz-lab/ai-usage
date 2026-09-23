import { homedir } from "node:os";
import { join } from "node:path";
import type { Credentials, Limit } from "./limits.ts";

// Protocol reference: steipete/CodexBar, docs/codex.md and CodexOAuthUsageFetcher.
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const string = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;
const jwt = (v: unknown): Record<string, unknown> => {
  try {
    return object(JSON.parse(Buffer.from(String(v).split(".")[1] ?? "", "base64url").toString()));
  } catch {
    return {};
  }
};

/** Read only the native CLI login. Never rotate tokens or publish auth material. */
export async function readCodexCredentials(env: Record<string, string | undefined> = process.env, home = homedir()): Promise<Credentials | null> {
  const dir = env.CODEX_HOME?.trim() || join(home, ".codex");
  const file = Bun.file(join(dir, "auth.json"));
  if (!(await file.exists())) return null;
  let auth: Record<string, unknown>;
  try { auth = object(await file.json()); } catch { return null; }
  if (auth.auth_mode === "apikey") return null;
  const tokens = object(auth.tokens);
  const token = string(tokens.access_token);
  if (!token) return null;
  const access = jwt(token);
  const identity = jwt(tokens.id_token);
  const claims = object(identity["https://api.openai.com/auth"]);
  const accessClaims = object(access["https://api.openai.com/auth"]);
  return {
    token,
    expiresAt: typeof access.exp === "number" && Number.isFinite(access.exp) ? access.exp * 1000 : null,
    account: string(tokens.account_id) ?? string(claims.chatgpt_account_id) ?? string(accessClaims.chatgpt_account_id),
    plan: string(claims.chatgpt_plan_type) ?? string(accessClaims.chatgpt_plan_type),
    tier: null,
  };
}

/** Codex windows report percent used and Unix seconds; a primary window can itself be weekly. */
export function parseCodexLimits(body: unknown): Limit[] {
  const b = object(body);
  const out: Limit[] = [];
  const windows = (value: unknown, label: string | null, id: string) => {
    const rate = object(value);
    for (const [key, fallback] of [["primary_window", "session"], ["secondary_window", "weekly"]] as const) {
      const w = object(rate[key]);
      if (typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent)) continue;
      const group = w.limit_window_seconds === 604800 ? "weekly" : w.limit_window_seconds === 18000 ? "session" : fallback;
      const percent = Math.min(100, Math.max(0, w.used_percent));
      out.push({
        kind: id ? `${id}/${key}` : group === "session" ? "session" : "weekly_all",
        group, label, percent,
        resetsAt: typeof w.reset_at === "number" && Number.isFinite(w.reset_at) && w.reset_at > 0 ? w.reset_at * 1000 : null,
        severity: percent >= 95 ? "critical" : percent >= 80 ? "warning" : "normal",
      });
    }
  };
  windows(b.rate_limit, null, "");
  if (Array.isArray(b.additional_rate_limits)) b.additional_rate_limits.forEach((entry, i) => {
    const e = object(entry);
    const label = string(e.limit_name) ?? string(e.metered_feature);
    if (label) windows(e.rate_limit, label, `extra-${i}`);
  });
  return out;
}

export function codexPlan(body: unknown): string | null {
  return string(object(body).plan_type);
}
