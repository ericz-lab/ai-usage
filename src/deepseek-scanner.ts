import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { type DeepseekScan, projectName, type Parsed, type SessionMeta, type Turn } from "./scanner.ts";
import type { Store } from "./store.ts";

/**
 * DeepSeek Harness (`dsh`) writes one session log per conversation under
 * `$DSH_HOME/sessions/<cwd encoded>/<session>/session.v4.jsonl`, normally
 * zstd-compressed (`.zstd`) and plain JSONL when its compression is off.
 * Each `assistant/message` event carries the model, the message id and the
 * four token counts under `data.usage`; `session` and `session/title` supply
 * the cwd, creation time and topic.
 *
 * Unlike the CLI transcripts, the harness log is compressed and is published
 * in frames, not appended as text. A changed file is therefore decompressed
 * and parsed whole; turns are upserted by message id, so the repeated work is
 * idempotent. Unchanged files (same size and mtime) are skipped.
 */

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const int = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The session id from a `.../<session>/session.v4.jsonl.zstd` path. */
export function sessionIdFromPath(path: string): string {
  return basename(dirname(path));
}

/** One harness log -> the turns and session metadata the store keeps. */
export function parseDeepseekSession(text: string, path = ""): Parsed {
  let sid = sessionIdFromPath(path);
  let cwd = "";
  let createdAt = 0;
  let delegationDepth = 0;
  let topic: string | null = null;
  let firstTs = 0;
  let lastTs = 0;
  const turns: Turn[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRec(value)) continue;
    const type = str(value.type);
    const data = isRec(value.data) ? value.data : {};
    const time = num(value.time);

    if (type === "session") {
      // Unlike the step events, the session header is top-level, not under `data`.
      sid = str(value.id) || sid;
      cwd = str(value.cwd);
      createdAt = num(value.createdAt);
      delegationDepth = num(value.delegationDepth);
      if (createdAt > 0) {
        firstTs = createdAt;
        lastTs = Math.max(lastTs, createdAt);
      }
      continue;
    }
    if (type === "session/title") {
      const title = str(data.title).trim();
      if (title) topic = title;
      continue;
    }
    if (type !== "assistant/message" || !sid) continue;

    const message = isRec(data.message) ? data.message : {};
    const usage = isRec(data.usage) ? data.usage : {};
    const input = int(usage.inputTokens);
    const output = int(usage.outputTokens);
    const cacheRead = int(usage.cacheReadTokens);
    const cacheWrite = int(usage.cacheWriteTokens);
    if (input + output + cacheRead + cacheWrite === 0) continue;
    if (time <= 0) continue;

    if (!firstTs || time < firstTs) firstTs = time;
    if (time > lastTs) lastTs = time;
    const source = isRec(message.source) ? message.source : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const tool = content.find((b) => isRec(b) && b.type === "tool-call");
    turns.push({
      sessionId: sid,
      ts: time,
      model: str(source.model),
      input,
      output,
      cacheRead,
      cacheWrite,
      tool: isRec(tool) ? str(tool.name) || null : null,
      messageId: str(message.id) || `dsh:${sid}:${num(value.seq)}`,
      subagent: delegationDepth > 0,
      agentId: delegationDepth > 0 ? sid : null,
    });
  }

  const sessions: SessionMeta[] = firstTs > 0 || topic !== null ? [{ sessionId: sid, cwd, project: cwd ? projectName(cwd) : "unknown", branch: "", firstTs, lastTs, topic, topicCustom: false }] : [];
  return { turns, sessions, dispatches: [] };
}

export type ScanDeepseekOptions = { now?: () => number; log?: (line: string) => void };

/** Read every changed session log under `dir`; a missing directory is skipped, a broken file is retried next scan. */
export async function scanDeepseekSessions(store: Store, dir: string, opts: ScanDeepseekOptions = {}): Promise<DeepseekScan> {
  const now = opts.now ?? Date.now;
  const started = now();
  const result: DeepseekScan = { dir, files: 0, newFiles: 0, updatedFiles: 0, turns: 0, sessions: 0, ms: 0, error: null };
  let st;
  try {
    st = await stat(dir);
  } catch {
    return result;
  }
  if (!st.isDirectory()) return result;

  const paths: string[] = [];
  const glob = new Bun.Glob("**/session*.jsonl*");
  for await (const p of glob.scan({ cwd: dir, absolute: true, onlyFiles: true })) if (/\.jsonl(?:\.zstd)?$/.test(p)) paths.push(p);
  paths.sort();

  for (const path of paths) {
    result.files++;
    try {
      const info = await stat(path);
      const prev = store.fileState(path);
      if (prev && prev.size === info.size && prev.mtime === info.mtimeMs) continue;
      const text = path.endsWith(".zstd") ? new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(await Bun.file(path).arrayBuffer()))) : await Bun.file(path).text();
      const parsed = parseDeepseekSession(text, path);
      store.write(parsed, { path, source: dir, size: info.size, mtime: info.mtimeMs, offset: info.size });
      if (prev) result.updatedFiles++;
      else result.newFiles++;
      result.turns += parsed.turns.length;
      result.sessions += parsed.sessions.length;
    } catch (e) {
      // A log being written can end in a partial zstd frame; leave its state alone so the next scan retries.
      result.error = `DeepSeek Harness: ${path}: ${(e as Error).message}`;
      opts.log?.(result.error);
    }
  }
  result.ms = now() - started;
  return result;
}
