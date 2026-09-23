import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Parsed } from "./scanner.ts";
import type { Store } from "./store.ts";

export type LedgerConfig = { dbPath: string | null; runtimesPath: string; runtimeNames?: string[] };
export type LedgerResult = { imported: number; error: string | null };
type Row = {
  id: number; app: string; tag: string; model: string; runtime: string; backend: string;
  started_at: number; duration_ms: number;
  input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null;
};
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Runtime names are operator-defined: inspect kinds rather than guessing from a model/name. */
export function codexRuntimeNames(text: string): string[] {
  const runtimes = record(record(Bun.YAML.parse(text)).runtimes);
  return Object.entries(runtimes).filter(([, v]) => record(v).kind === "codex-cli").map(([name]) => name).sort();
}

/** Space ledger counters are already separate categories. Do not subtract cached input again. */
export function parseLedgerRow(row: Row, machine: string): Parsed | null {
  const values = [row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens];
  if (!values.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return null;
  if (!values.some((n) => n! > 0) || !Number.isSafeInteger(row.started_at) || row.started_at <= 0) return null;
  const id = `space-model:${encodeURIComponent(machine)}:${row.id}:${row.started_at}`;
  return {
    sessions: [{ sessionId: id, cwd: `ai-space/${row.app}`, project: `ai-space/${row.app}`, branch: "", firstTs: row.started_at, lastTs: row.started_at + Math.max(0, row.duration_ms), topic: `${row.tag} · ${row.runtime} · ${row.backend}`, topicCustom: false }],
    turns: [{ sessionId: id, messageId: id, ts: row.started_at, model: row.model, input: row.input_tokens!, output: row.output_tokens!, cacheRead: row.cache_read_tokens!, cacheWrite: row.cache_write_tokens!, tool: null, subagent: false, agentId: null }],
    dispatches: [],
  };
}

/** Completed calls are appended by Space. Read in bounded batches and checkpoint with imported rows. */
export async function scanSpaceLedger(store: Store, config: LedgerConfig, machine: string): Promise<LedgerResult> {
  const result: LedgerResult = { imported: 0, error: null };
  if (!config.dbPath || !(await Bun.file(config.dbPath).exists())) return result;
  let db: Database | undefined;
  try {
    const names = config.runtimeNames ?? (await Bun.file(config.runtimesPath).exists() ? codexRuntimeNames(await Bun.file(config.runtimesPath).text()) : []);
    if (!names.length) return result;
    db = new Database(config.dbPath, { readonly: true });
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(model_calls)").all();
    if (!columns.length) return result;
    if (!columns.some((c) => c.name === "runtime")) return result; // Predates named runtimes/Codex support.
    const fields = "id, app, tag, model, runtime, backend, started_at, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens";
    const key = `space-ledger:${hash([machine, config.dbPath, [...names].sort()])}`;
    let cursor = 0;
    const saved = store.getMeta(key);
    if (saved) {
      try {
        const checkpoint = JSON.parse(saved) as { id: number; fingerprint: string };
        const anchor = db.query<Row, [number]>(`SELECT ${fields} FROM model_calls WHERE id = ?`).get(checkpoint.id);
        // A replaced/restored ledger or retention cleanup invalidates the anchor. Stable IDs make replay safe.
        if (anchor && hash(anchor) === checkpoint.fingerprint) cursor = checkpoint.id;
      } catch { /* Rebuild from the authoritative ledger if the cache is invalid. */ }
    }
    const query = db.query<Row, (string | number)[]>(`SELECT ${fields} FROM model_calls
      WHERE id > ? AND origin = 'run' AND runtime IN (${names.map(() => "?").join(",")}) ORDER BY id LIMIT 500`);
    while (true) {
      const rows = query.all(cursor, ...names);
      if (!rows.length) break;
      const parsed: Parsed = { sessions: [], turns: [], dispatches: [] };
      for (const row of rows) {
        const value = parseLedgerRow(row, machine);
        if (!value) continue; // Includes calls without usage; never invent zero usage/cost.
        parsed.sessions.push(...value.sessions);
        parsed.turns.push(...value.turns);
      }
      const last = rows.at(-1)!;
      store.write(parsed, undefined, { key, value: JSON.stringify({ id: last.id, fingerprint: hash(last) }) });
      result.imported += parsed.turns.length;
      cursor = last.id;
    }
  } catch (e) {
    result.error = `Space ledger: ${(e as Error).message}`;
  } finally { db?.close(); }
  return result;
}
