import { createHash } from "node:crypto";
import { basename } from "node:path";
import { projectName, type Parsed, type SessionMeta, type Usage } from "./scanner.ts";

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Rec : {};
const str = (v: unknown): string => typeof v === "string" ? v : "";
const num = (v: unknown): number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
// Raw input includes both cache reads and writes. Reasoning is already in output.
type Counters = { input: number; cached: number; written: number; output: number };
const keys = ["input", "cached", "written", "output"] as const;
const counters = (value: unknown): Counters | null => {
  const v = obj(value);
  if (typeof v.input_tokens !== "number" || typeof v.output_tokens !== "number") return null;
  return { input: num(v.input_tokens), cached: num(v.cached_input_tokens ?? v.cache_read_input_tokens), written: num(v.cache_write_input_tokens), output: num(v.output_tokens) };
};
const subtract = (a: Counters, b: Counters): Counters => Object.fromEntries(keys.map((k) => [k, Math.max(0, a[k] - b[k])])) as Counters;
const zero = (): Counters => ({ input: 0, cached: 0, written: 0, output: 0 });
const normalize = (v: Counters): Usage => {
  const cacheRead = Math.min(v.input, v.cached);
  const cacheWrite = Math.min(v.input - cacheRead, v.written);
  return { input: v.input - cacheRead - cacheWrite, cacheRead, cacheWrite, output: v.output };
};

/** Saved together with the byte cursor, so an appended chunk keeps its model and cumulative baseline. */
export type CodexState = {
  version: 1;
  session: SessionMeta;
  model: string;
  serviceTier: string | null;
  total: Counters | null;
  lastEvent: string | null;
  resetAllowed: boolean;
  subagent: boolean;
  inheritedBefore: number | null;
  startOrdinal: number | null;
};

export function parseCodexTranscript(text: string, path = "", previous?: CodexState): Parsed & { state: CodexState } {
  const state: CodexState = previous ? structuredClone(previous) : {
    version: 1,
    session: { sessionId: `codex:${basename(path, ".jsonl").replace(/^rollout-.*?(\w{8}-\w{4}-\w{4}-\w{4}-\w{12})$/, "$1")}`, cwd: "", project: "unknown", branch: "", firstTs: 0, lastTs: 0, topic: null, topicCustom: false },
    model: "codex-unknown", serviceTier: null, total: null, lastEvent: null, resetAllowed: false, subagent: false, inheritedBefore: null, startOrdinal: null,
  };
  const turns: Parsed["turns"] = [];
  const meta = state.session;
  for (const line of text.split("\n")) {
    if (!/"(?:session_meta|turn_context|token_count|compacted)"/.test(line)) continue;
    let r: Rec;
    try { r = obj(JSON.parse(line)); } catch { continue; }
    const p = obj(r.payload);
    const ts = Date.parse(str(r.timestamp));
    if (r.type === "session_meta") {
      const id = str(p.id) || str(p.session_id) || str(p.sessionId);
      if (id) meta.sessionId = `codex:${id}`;
      meta.cwd = str(p.cwd) || meta.cwd;
      meta.project = projectName(meta.cwd);
      meta.branch = str(obj(p.git).branch) || meta.branch;
      const source = obj(p.source);
      state.subagent = !!source.subagent || str(p.source).startsWith("subagent") || !!obj(p.thread_source).subagent;
      const fork = p.forked_from_id ?? p.forked_from ?? p.forkedFromId ?? p.history_base_thread_id;
      if (state.subagent || fork) state.inheritedBefore = Date.parse(str(p.timestamp) || str(r.timestamp)) || -1;
      if (typeof p.subagent_history_start_ordinal === "number" && p.subagent_history_start_ordinal >= 0) state.startOrdinal = p.subagent_history_start_ordinal;
      continue;
    }
    if (r.type === "turn_context") {
      state.model = str(p.model) || state.model;
      state.serviceTier = str(p.service_tier) || null;
      if (str(p.cwd)) { meta.cwd = str(p.cwd); meta.project = projectName(meta.cwd); }
      continue;
    }
    if (r.type === "compacted") { state.resetAllowed = true; continue; }
    if (r.type !== "event_msg" || p.type !== "token_count" || !Number.isFinite(ts)) continue;
    const info = obj(p.info);
    const total = counters(info.total_token_usage);
    const last = counters(info.last_token_usage);
    if (!total && !last) continue;
    const inherited = state.startOrdinal !== null
      ? typeof r.ordinal !== "number" || r.ordinal < state.startOrdinal
      : state.inheritedBefore !== null && ((!Number.isFinite(state.inheritedBefore) || state.inheritedBefore < 0) || ts <= state.inheritedBefore);
    if (inherited) { if (total) state.total = total; continue; }
    // Compaction can reset cumulative counters. Only an explicit boundary may
    // lower the baseline; delayed older telemetry otherwise must not add usage.
    if (state.resetAllowed && total && state.total && total.input < state.total.input && total.output < state.total.output) state.total = null;
    state.resetAllowed = false;
    // Rate-limit-only updates repeat the same cumulative usage, sometimes with a new timestamp.
    if (total && state.total && keys.every((k) => total[k] <= state.total![k])) continue;
    const fingerprint = JSON.stringify([ts, total, last]);
    if (fingerprint === state.lastEvent) continue;
    let delta = last ?? total!;
    if (total && state.total) {
      const growth = subtract(total, state.total);
      // Cap each component by a known per-request count; a missing event must not
      // turn a cumulative gap into one huge, incorrectly priced request.
      delta = last ? Object.fromEntries(keys.map((k) => [k, Math.min(last[k], growth[k])])) as Counters : growth;
    } else if (!last && state.inheritedBefore !== null) {
      // A fork without its copied prefix needs a baseline before costs can be attributed.
      state.total = total;
      continue;
    }
    if (total) state.total = Object.fromEntries(keys.map((k) => [k, Math.max(total[k], state.total?.[k] ?? 0)])) as Counters;
    else {
      const baseline = state.total ?? zero();
      state.total = Object.fromEntries(keys.map((k) => [k, baseline[k] + delta[k]])) as Counters;
    }
    state.lastEvent = fingerprint;
    const usage = normalize(delta);
    if (!Object.values(usage).some((n) => n > 0)) continue;
    if (!meta.firstTs || ts < meta.firstTs) meta.firstTs = ts;
    meta.lastTs = Math.max(meta.lastTs, ts);
    // Stable across archive moves, rescans, copies and peer exports. Never key by local path.
    const hash = createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
    turns.push({ ...usage, sessionId: meta.sessionId, ts, model: state.model === "codex-unknown" ? str(info.model) || str(p.model) || state.model : state.model, serviceTier: state.serviceTier, tool: null, messageId: `${meta.sessionId}:${hash}`, subagent: state.subagent, agentId: state.subagent ? meta.sessionId : null });
  }
  return { turns, sessions: meta.firstTs ? [{ ...meta }] : [], dispatches: [], state };
}
