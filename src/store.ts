import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Dispatch, Parsed, SessionMeta, Turn } from "./scanner.ts";

/**
 * The SQLite cache of everything the scanner has read here and everything
 * pulled from peer machines. It is derived data: delete the file and the next
 * scan and pull rebuild it.
 *
 *   files      one row per local transcript: size, mtime and the byte offset consumed
 *   sessions   one row per session: machine, where it ran, when, its topic
 *   turns      one row per model response with token usage; unique by message id
 *   agents     what the parent recorded when a subagent finished
 *   meta       key/value (last scan time, per-peer pull state)
 *
 * `machine` is '' for rows scanned on this machine and the peer's name (as
 * this hub calls it) for pulled rows. Ids are the CLI's own UUIDs and message
 * ids, unique across machines, so a row keeps its identity wherever it came
 * from.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path    TEXT PRIMARY KEY,
  source  TEXT NOT NULL,
  size    INTEGER NOT NULL,
  mtime   REAL NOT NULL,
  offset  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  machine      TEXT NOT NULL DEFAULT '',
  cwd          TEXT NOT NULL DEFAULT '',
  project      TEXT NOT NULL DEFAULT 'unknown',
  branch       TEXT NOT NULL DEFAULT '',
  first_ts     INTEGER NOT NULL DEFAULT 0,
  last_ts      INTEGER NOT NULL DEFAULT 0,
  topic        TEXT,
  topic_custom INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_ts);
CREATE TABLE IF NOT EXISTS turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  machine     TEXT NOT NULL DEFAULT '',
  session_id  TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  model       TEXT NOT NULL,
  input       INTEGER NOT NULL,
  output      INTEGER NOT NULL,
  cache_read  INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  tool        TEXT,
  message_id  TEXT NOT NULL DEFAULT '',
  subagent    INTEGER NOT NULL DEFAULT 0,
  agent_id    TEXT,
  service_tier TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS turns_message ON turns(message_id) WHERE message_id != '';
CREATE INDEX IF NOT EXISTS turns_ts ON turns(ts);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id);
CREATE TABLE IF NOT EXISTS agents (
  agent_id     TEXT PRIMARY KEY,
  machine      TEXT NOT NULL DEFAULT '',
  agent_type   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  status       TEXT,
  total_tokens INTEGER,
  duration_ms  INTEGER,
  tool_uses    INTEGER
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export type FileState = { path: string; source: string; size: number; mtime: number; offset: number };

export type TurnRow = {
  service_tier?: string | null;
  machine: string;
  session_id: string;
  ts: number;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  tool: string | null;
  message_id: string;
  subagent: number;
  agent_id: string | null;
};

export type SessionRow = {
  machine: string;
  session_id: string;
  cwd: string;
  project: string;
  branch: string;
  first_ts: number;
  last_ts: number;
  topic: string | null;
  topic_custom: number;
};

export type AgentRow = {
  machine: string;
  agent_id: string;
  agent_type: string;
  session_id: string;
  completed_at: number;
  status: string | null;
  total_tokens: number | null;
  duration_ms: number | null;
  tool_uses: number | null;
};

/** What one machine hands another: its own rows changed since a time. */
export type Export = { sessions: SessionRow[]; turns: TurnRow[]; agents: AgentRow[] };

const TURN_COLS = "machine, session_id, ts, model, input, output, cache_read, cache_write, tool, message_id, subagent, agent_id, service_tier";

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(turns)").all();
    if (!columns.some((c) => c.name === "service_tier")) this.db.exec("ALTER TABLE turns ADD COLUMN service_tier TEXT");
  }

  close(): void {
    this.db.close();
  }

  fileState(path: string): FileState | null {
    return this.db.query<FileState, [string]>("SELECT path, source, size, mtime, offset FROM files WHERE path = ?").get(path);
  }

  /** One local transcript's new content and its new file state, in one transaction. */
  write(parsed: Parsed, file: FileState, parserState?: { key: string; value: string }): void {
    this.db.transaction(() => {
      if (parserState) this.setMeta(parserState.key, parserState.value);
      for (const s of parsed.sessions) this.upsertSession("", s);
      for (const t of parsed.turns) this.upsertTurn("", t);
      for (const d of parsed.dispatches) this.upsertDispatch("", d);
      this.db.query("INSERT OR REPLACE INTO files (path, source, size, mtime, offset) VALUES (?, ?, ?, ?, ?)").run(file.path, file.source, file.size, file.mtime, file.offset);
    })();
  }

  /** Rows pulled from a peer, labelled with the name this hub gives it. */
  import(machine: string, x: Export): void {
    if (!machine) throw new Error("import needs a machine name");
    this.db.transaction(() => {
      for (const s of x.sessions)
        this.upsertSession(machine, { sessionId: s.session_id, cwd: s.cwd, project: s.project, branch: s.branch, firstTs: s.first_ts, lastTs: s.last_ts, topic: s.topic, topicCustom: s.topic_custom === 1 });
      for (const t of x.turns)
        this.upsertTurn(machine, {
          sessionId: t.session_id,
          ts: t.ts,
          model: t.model,
          serviceTier: t.service_tier ?? null,
          input: t.input,
          output: t.output,
          cacheRead: t.cache_read,
          cacheWrite: t.cache_write,
          tool: t.tool,
          messageId: t.message_id,
          subagent: t.subagent === 1,
          agentId: t.agent_id,
        });
      for (const a of x.agents)
        this.upsertDispatch(machine, { agentId: a.agent_id, agentType: a.agent_type, sessionId: a.session_id, completedAt: a.completed_at, status: a.status, totalTokens: a.total_tokens, durationMs: a.duration_ms, toolUses: a.tool_uses });
    })();
  }

  private upsertSession(machine: string, s: SessionMeta): void {
    this.db
      .query(
        `INSERT INTO sessions (session_id, machine, cwd, project, branch, first_ts, last_ts, topic, topic_custom)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           machine = excluded.machine,
           cwd = CASE WHEN sessions.cwd = '' THEN excluded.cwd ELSE sessions.cwd END,
           project = CASE WHEN sessions.cwd = '' THEN excluded.project ELSE sessions.project END,
           branch = CASE WHEN sessions.branch = '' THEN excluded.branch ELSE sessions.branch END,
           first_ts = CASE WHEN sessions.first_ts = 0 OR (excluded.first_ts > 0 AND excluded.first_ts < sessions.first_ts) THEN excluded.first_ts ELSE sessions.first_ts END,
           last_ts = MAX(sessions.last_ts, excluded.last_ts),
           topic = CASE WHEN excluded.topic IS NOT NULL AND (excluded.topic_custom = 1 OR sessions.topic_custom = 0) THEN excluded.topic ELSE sessions.topic END,
           topic_custom = MAX(sessions.topic_custom, excluded.topic_custom)`,
      )
      .run(s.sessionId, machine, s.cwd, s.project, s.branch, s.firstTs, s.lastTs, s.topic, s.topicCustom ? 1 : 0);
  }

  private upsertTurn(machine: string, t: Turn): void {
    this.db
      .query(
        `INSERT INTO turns (${TURN_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) WHERE message_id != '' DO UPDATE SET
           machine = excluded.machine, ts = excluded.ts, model = excluded.model, service_tier = excluded.service_tier, input = excluded.input, output = excluded.output,
           cache_read = excluded.cache_read, cache_write = excluded.cache_write,
           tool = COALESCE(excluded.tool, turns.tool), subagent = excluded.subagent, agent_id = COALESCE(excluded.agent_id, turns.agent_id)`,
      )
      .run(machine, t.sessionId, t.ts, t.model, t.input, t.output, t.cacheRead, t.cacheWrite, t.tool, t.messageId, t.subagent ? 1 : 0, t.agentId, t.serviceTier ?? null);
  }

  private upsertDispatch(machine: string, d: Dispatch): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO agents (agent_id, machine, agent_type, session_id, completed_at, status, total_tokens, duration_ms, tool_uses)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.agentId, machine, d.agentType, d.sessionId, d.completedAt, d.status, d.totalTokens, d.durationMs, d.toolUses);
  }

  /** Turns with `from <= ts < to`, oldest first. */
  turnsBetween(from: number, to: number): TurnRow[] {
    return this.db.query<TurnRow, [number, number]>(`SELECT ${TURN_COLS} FROM turns WHERE ts >= ? AND ts < ? ORDER BY ts`).all(from, to);
  }

  /** Sessions still active at or after `from`: every session that can own a turn in a window starting there. */
  sessionsSince(from: number): SessionRow[] {
    return this.db.query<SessionRow, [number]>("SELECT * FROM sessions WHERE last_ts >= ?").all(from);
  }

  agents(): AgentRow[] {
    return this.db.query<AgentRow, []>("SELECT * FROM agents").all();
  }

  /** This machine's own rows from `since` on, for a hub that pulls them. */
  exportSince(since: number): Export {
    return {
      sessions: this.db.query<SessionRow, [number]>("SELECT * FROM sessions WHERE machine = '' AND last_ts >= ? ORDER BY last_ts").all(since),
      turns: this.db.query<TurnRow, [number]>(`SELECT ${TURN_COLS} FROM turns WHERE machine = '' AND ts >= ? ORDER BY ts`).all(since),
      agents: this.db.query<AgentRow, [number]>("SELECT * FROM agents WHERE machine = '' AND completed_at >= ? ORDER BY completed_at").all(since),
    };
  }

  /** The newest turn pulled from a machine; where the next pull resumes from. */
  latestTurn(machine: string): number {
    return this.db.query<{ ts: number | null }, [string]>("SELECT MAX(ts) AS ts FROM turns WHERE machine = ?").get(machine)?.ts ?? 0;
  }

  /** Every model ever seen with its turn count, busiest first. */
  models(): { model: string; turns: number }[] {
    return this.db.query<{ model: string; turns: number }, []>("SELECT model, COUNT(*) AS turns FROM turns GROUP BY model ORDER BY turns DESC, model").all();
  }

  /** Every machine with rows, '' being this one, busiest first. */
  machines(): { machine: string; turns: number }[] {
    return this.db.query<{ machine: string; turns: number }, []>("SELECT machine, COUNT(*) AS turns FROM turns GROUP BY machine ORDER BY (machine = '') DESC, turns DESC, machine").all();
  }

  counts(): { files: number; sessions: number; turns: number; firstTs: number | null; lastTs: number | null } {
    const files = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM files").get()!.n;
    const sessions = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions WHERE first_ts > 0").get()!.n;
    const t = this.db.query<{ n: number; first: number | null; last: number | null }, []>("SELECT COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM turns").get()!;
    return { files, sessions, turns: t.n, firstTs: t.first, lastTs: t.last };
  }

  getMeta(key: string): string | null {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  deleteMeta(key: string): void {
    this.db.query("DELETE FROM meta WHERE key = ?").run(key);
  }

  /** Every meta key with a prefix, for the per-peer pull states. */
  metaWithPrefix(prefix: string): Record<string, string> {
    const rows = this.db.query<{ key: string; value: string }, [string]>("SELECT key, value FROM meta WHERE key LIKE ? || '%'").all(prefix);
    return Object.fromEntries(rows.map((r) => [r.key.slice(prefix.length), r.value]));
  }
}
