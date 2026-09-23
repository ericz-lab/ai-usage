import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Environment -> config. Everything has a default so `bun src/index.ts` works
 * on a laptop with no .env; ai-space supplies PORT, DATABASE_URL and
 * SPACE_APP_DATA_DIR when it runs the service (docs/app-spec.md there).
 */

/** dashboard: scan, publish, pull, serve the page. collector: scan and publish only; the page and the reads are off. */
export type Role = "dashboard" | "collector";

export type Config = {
  port: number;
  role: Role;
  /** SQLite file holding the scanned turns; a cache that can be deleted and rebuilt. */
  dbPath: string;
  /** Directories scanned recursively for `*.jsonl` transcripts. */
  sources: string[];
  /** Milliseconds between background scans. */
  scanIntervalMs: number;
};

export const DEFAULT_PORT = 8880;

/** Claude Code, its Xcode integration, and native/archived Codex sessions. */
export function defaultSources(home = homedir(), env: Record<string, string | undefined> = process.env): string[] {
  const codex = expandHome(env.CODEX_HOME?.trim() || join(home, ".codex"), home);
  return [join(home, ".claude", "projects"), join(home, "Library", "Developer", "Xcode", "CodingAssistant", "ClaudeAgentConfig", "projects"), join(codex, "sessions"), join(codex, "archived_sessions")];
}

export function expandHome(p: string, home = homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

/** `DATABASE_URL` (sqlite:///abs/path or sqlite://rel/path) wins; else the data directory; else ./data. */
export function dbPathFrom(env: Record<string, string | undefined>, cwd = process.cwd()): string {
  const url = (env.DATABASE_URL ?? "").trim();
  if (url) {
    const m = url.match(/^sqlite:\/\/(.+)$/);
    if (!m) throw new Error(`DATABASE_URL must be sqlite://<path>, got ${url}`);
    return resolve(cwd, m[1]!);
  }
  return resolve(cwd, env.SPACE_APP_DATA_DIR ?? "data", "usage.db");
}

export function loadConfig(env: Record<string, string | undefined> = process.env, home = homedir()): Config {
  const port = Number(env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`PORT must be a port number, got ${env.PORT}`);
  const sources = (env.USAGE_SOURCES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => resolve(expandHome(s, home)));
  const role = (env.USAGE_ROLE ?? "dashboard").trim().toLowerCase();
  if (role !== "dashboard" && role !== "collector") throw new Error(`USAGE_ROLE must be dashboard or collector, got ${env.USAGE_ROLE}`);
  const interval = Number(env.USAGE_SCAN_INTERVAL ?? 300);
  if (!Number.isFinite(interval) || interval < 10) throw new Error(`USAGE_SCAN_INTERVAL must be at least 10 seconds, got ${env.USAGE_SCAN_INTERVAL}`);
  return {
    port,
    role,
    dbPath: dbPathFrom(env),
    sources: sources.length ? sources : defaultSources(home, env),
    scanIntervalMs: interval * 1000,
  };
}
