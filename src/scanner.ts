import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { parseCodexTranscript, type CodexState } from "./codex-scanner.ts";
import type { Store } from "./store.ts";

/**
 * Claude Code writes one JSONL file per session under `<projects>/<cwd
 * encoded>/<session>.jsonl`, and one per dispatched subagent under
 * `<session>/subagents/agent-<id>.jsonl`. Each line is a record; the
 * `assistant` records carry `message.usage` (the four token kinds) and
 * `message.model`. One API response is logged several times while it streams,
 * all sharing `message.id`; the last record has the final tallies, so turns
 * are keyed by that id and the last one wins.
 *
 * `parseTranscript` is pure. `scanSources` walks the directories, reads only
 * the bytes appended since the last scan (a file is tracked by path, size,
 * mtime and consumed offset) and writes what it found to the store.
 */

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type Turn = Usage & {
  sessionId: string;
  ts: number;
  model: string;
  serviceTier?: string | null;
  tool: string | null;
  /** Empty when the record had none; such turns are kept as they are. */
  messageId: string;
  subagent: boolean;
  agentId: string | null;
};

export type SessionMeta = {
  sessionId: string;
  cwd: string;
  project: string;
  branch: string;
  firstTs: number;
  lastTs: number;
  topic: string | null;
  /** The topic came from a custom-title record (the person named it); an ai-title never replaces it. */
  topicCustom: boolean;
};

/** What the parent session recorded when a subagent finished (`toolUseResult` on the closing user record). */
export type Dispatch = {
  agentId: string;
  agentType: string;
  sessionId: string;
  completedAt: number;
  status: string | null;
  totalTokens: number | null;
  durationMs: number | null;
  toolUses: number | null;
};

export type Parsed = { turns: Turn[]; sessions: SessionMeta[]; dispatches: Dispatch[] };

/** The last two path components: `/home/me/work/app` -> `work/app`. */
export function projectName(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
  if (!parts.length) return "unknown";
  return parts.slice(-2).join("/");
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Session and agent ids from the file's place in the tree, for records that carry none. */
export function idsFromPath(path: string): { sessionId: string; agentId: string | null } {
  const file = basename(path, ".jsonl");
  const dir = dirname(path);
  if (basename(dir) === "subagents") return { sessionId: basename(dirname(dir)), agentId: file.replace(/^agent-/, "") };
  return { sessionId: file, agentId: null };
}

/** Lines that can matter carry one of these; the rest (attachments, snapshots, progress) are skipped unparsed. */
const INTERESTING = ['"type":"assistant"', '"type":"user"', '-title"'];

export function parseTranscript(text: string, path = ""): Parsed {
  const fromPath = idsFromPath(path);
  const inSubagentFile = fromPath.agentId !== null;
  const byId = new Map<string, Turn>();
  const noId: Turn[] = [];
  const sessions = new Map<string, SessionMeta>();
  const dispatches = new Map<string, Dispatch>();

  const meta = (sid: string): SessionMeta => {
    let m = sessions.get(sid);
    if (!m) {
      m = { sessionId: sid, cwd: "", project: "unknown", branch: "", firstTs: 0, lastTs: 0, topic: null, topicCustom: false };
      sessions.set(sid, m);
    }
    return m;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || !INTERESTING.some((k) => line.includes(k))) continue;
    let r: Rec;
    try {
      const v = JSON.parse(line);
      if (!isRec(v)) continue;
      r = v;
    } catch {
      continue;
    }
    const type = str(r.type);
    const sid = str(r.sessionId) || fromPath.sessionId;
    if (!sid) continue;

    if (type === "custom-title" || type === "ai-title") {
      const title = str(type === "custom-title" ? r.customTitle : r.aiTitle).trim();
      if (!title) continue;
      const m = meta(sid);
      if (type === "custom-title") {
        m.topic = title;
        m.topicCustom = true;
      } else if (!m.topicCustom) m.topic = title;
      continue;
    }
    if (type !== "assistant" && type !== "user") continue;

    const ts = Date.parse(str(r.timestamp));
    const m = meta(sid);
    if (Number.isFinite(ts)) {
      if (!m.firstTs || ts < m.firstTs) m.firstTs = ts;
      if (ts > m.lastTs) m.lastTs = ts;
    }
    const cwd = str(r.cwd);
    if (cwd && !m.cwd) {
      m.cwd = cwd;
      m.project = projectName(cwd);
    }
    const branch = str(r.gitBranch);
    if (branch && !m.branch) m.branch = branch;

    if (type === "user") {
      const tur = r.toolUseResult;
      if (isRec(tur) && str(tur.agentId) && str(tur.agentType) && Number.isFinite(ts)) {
        dispatches.set(str(tur.agentId), {
          agentId: str(tur.agentId),
          agentType: str(tur.agentType),
          sessionId: sid,
          completedAt: ts,
          status: str(tur.status) || null,
          totalTokens: typeof tur.totalTokens === "number" ? tur.totalTokens : null,
          durationMs: typeof tur.totalDurationMs === "number" ? tur.totalDurationMs : null,
          toolUses: typeof tur.totalToolUseCount === "number" ? tur.totalToolUseCount : null,
        });
      }
      continue;
    }

    if (!Number.isFinite(ts)) continue;
    const msg = isRec(r.message) ? r.message : {};
    const usage = isRec(msg.usage) ? msg.usage : {};
    const turn: Turn = {
      sessionId: sid,
      ts,
      model: str(msg.model),
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      tool: null,
      messageId: str(msg.id),
      subagent: r.isSidechain === true || !!str(r.agentId) || inSubagentFile,
      agentId: str(r.agentId) || fromPath.agentId,
    };
    if (turn.input + turn.output + turn.cacheRead + turn.cacheWrite === 0) continue;
    if (Array.isArray(msg.content)) {
      const tool = msg.content.find((b) => isRec(b) && b.type === "tool_use");
      if (isRec(tool)) turn.tool = str(tool.name) || null;
    }
    if (turn.messageId) byId.set(turn.messageId, turn);
    else noId.push(turn);
  }

  return {
    turns: [...noId, ...byId.values()],
    sessions: [...sessions.values()].filter((s) => s.firstTs > 0 || s.topic !== null),
    dispatches: [...dispatches.values()],
  };
}

// ---------------------------------------------------------------- incremental scan

export type ScanResult = {
  ledger?: { imported: number; error: string | null };
  sources: string[];
  files: number;
  newFiles: number;
  updatedFiles: number;
  turns: number;
  sessions: number;
  dispatches: number;
  ms: number;
};

/** A line without a newline is consumed only once the file has been quiet this long. */
const SETTLE_MS = 10_000;

export type ScanOptions = { now?: () => number; log?: (line: string) => void };

/** Walk every source, read what is new in each transcript and write it to the store. Missing sources are skipped. */
export async function scanSources(store: Store, sources: string[], opts: ScanOptions = {}): Promise<ScanResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const result: ScanResult = { sources: [], files: 0, newFiles: 0, updatedFiles: 0, turns: 0, sessions: 0, dispatches: 0, ms: 0 };
  const glob = new Bun.Glob("**/*.jsonl");
  for (const dir of sources) {
    let st;
    try {
      st = await stat(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    result.sources.push(dir);
    const paths: string[] = [];
    for await (const p of glob.scan({ cwd: dir, absolute: true, onlyFiles: true })) paths.push(p);
    paths.sort();
    for (const path of paths) {
      result.files++;
      try {
        const r = await scanFile(store, path, dir, now());
        if (!r) continue;
        if (r.fresh) result.newFiles++;
        else result.updatedFiles++;
        result.turns += r.turns;
        result.sessions += r.sessions;
        result.dispatches += r.dispatches;
      } catch (e) {
        opts.log?.(`skipped ${path}: ${(e as Error).message}`);
      }
    }
  }
  result.ms = now() - started;
  store.setMeta("last_scan", String(started));
  return result;
}

async function scanFile(store: Store, path: string, source: string, now: number): Promise<{ fresh: boolean; turns: number; sessions: number; dispatches: number } | null> {
  const st = await stat(path);
  const size = st.size;
  const mtime = st.mtimeMs;
  const prev = store.fileState(path);
  const stateKey = `codex-file:${path}`;
  const saved = store.getMeta(stateKey);
  const codex = saved !== null || /"type"\s*:\s*"session_meta"/.test(await Bun.file(path).slice(0, 4096).text());
  let state: CodexState | undefined;
  if (saved) {
    try { const value = JSON.parse(saved); if (value.version === 1) state = value; } catch { /* Rebuild invalid parser state. */ }
  }
  const settledTail = prev && prev.offset < size && now - mtime > SETTLE_MS;
  if (prev && prev.size === size && prev.mtime === mtime && !settledTail && (!codex || state)) return null;
  // Appended since last time: read from the consumed offset; rewritten or truncated: read it all.
  const offset = prev && size >= prev.size && !(size === prev.size && mtime !== prev.mtime) && (!codex || state) ? prev.offset : 0;
  const text = await Bun.file(path).slice(offset).text();
  let cut = text.lastIndexOf("\n") + 1;
  if (cut < text.length && now - mtime > SETTLE_MS) cut = text.length;
  const chunk = text.slice(0, cut);
  const consumed = offset + Buffer.byteLength(chunk);
  const parsed = codex ? parseCodexTranscript(chunk, path, offset ? state : undefined) : parseTranscript(chunk, path);
  store.write(parsed, { path, source, size, mtime, offset: consumed }, "state" in parsed ? { key: stateKey, value: JSON.stringify(parsed.state) } : undefined);
  return { fresh: !prev, turns: parsed.turns.length, sessions: parsed.sessions.length, dispatches: parsed.dispatches.length };
}
