import { S3Client } from "bun";
import type { AgentRow, Export, SessionRow, Store, TurnRow } from "./store.ts";

/**
 * The shared store: one S3 prefix every machine's ai-usage writes to and
 * reads from, so machines never need to reach each other, only the bucket.
 * ai-space hands the prefix over as BLOB_URL (`storage.blobs: s3` in
 * space.yaml; the same bucket on every space that shares the credentials); a
 * standalone machine sets BLOB_URL and S3_* itself.
 *
 *   <prefix><machine>/manifest.json        { machine, updatedAt, files: { path: { hash, rows } } }
 *   <prefix><machine>/turns/<day>.jsonl    this machine's turns of one UTC day, one row per line
 *   <prefix><machine>/sessions.jsonl
 *   <prefix><machine>/agents.jsonl
 *
 * Publish writes the files whose content hash changed since the last publish
 * (today's, and any day still receiving final usage tallies) and then the
 * manifest. Pull lists every other machine's manifest and downloads the files
 * whose hash differs from the one it imported last. Both are idempotent and
 * cheap; a machine that was offline for a month catches up in one round.
 */

export type ObjectStore = {
  put(key: string, body: string): Promise<void>;
  /** null when the key does not exist. */
  get(key: string): Promise<string | null>;
  /** Every key under a prefix. */
  list(prefix: string): Promise<string[]>;
};

export type ManifestFile = { hash: string; rows: number };
export type Manifest = { machine: string; updatedAt: number; files: Record<string, ManifestFile> };
export type SharedMachine = { name: string; updatedAt: number | null; pulledAt: number | null; ok: boolean; error: string | null; rows: number };
export type SyncResult = { published: string[]; pulled: SharedMachine[]; skipped: boolean };

export type SharedOptions = {
  store: Store;
  objects: ObjectStore;
  /** This machine's name; also its directory in the store. */
  machine: string;
  /** Sync no more often than this unless forced. */
  intervalMs?: number;
  now?: () => number;
  log?: (line: string) => void;
};

const META = "shared:";
const KEY_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `s3://bucket/prefix/` -> an object store on that prefix with the S3_* credentials of the environment. */
export function objectStoreFromEnv(env: Record<string, string | undefined>): { url: string; objects: ObjectStore } | null {
  const url = (env.BLOB_URL ?? "").trim();
  const m = url.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  if (!m) return null;
  const bucket = m[1]!;
  let prefix = m[2] ?? "";
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  const client = new S3Client({
    bucket,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    ...(env.S3_REGION ? { region: env.S3_REGION } : {}),
    ...(env.S3_ACCESS_KEY_ID ? { accessKeyId: env.S3_ACCESS_KEY_ID } : {}),
    ...(env.S3_SECRET_ACCESS_KEY ? { secretAccessKey: env.S3_SECRET_ACCESS_KEY } : {}),
  });
  return { url: `s3://${bucket}/${prefix}`, objects: s3ObjectStore(client, prefix) };
}

export function s3ObjectStore(client: S3Client, prefix: string): ObjectStore {
  return {
    put: async (key, body) => {
      await client.write(prefix + key, body, { type: key.endsWith(".json") ? "application/json" : "application/x-ndjson" });
    },
    get: async (key) => {
      const f = client.file(prefix + key);
      if (!(await f.exists())) return null;
      return f.text();
    },
    list: async (sub) => {
      const keys: string[] = [];
      let startAfter: string | undefined;
      for (;;) {
        const page = await client.list({ prefix: prefix + sub, maxKeys: 1000, ...(startAfter ? { startAfter } : {}) });
        for (const c of page.contents ?? []) if (c.key) keys.push(c.key.slice(prefix.length));
        if (!page.isTruncated || !page.contents?.length) break;
        startAfter = page.contents.at(-1)!.key;
      }
      return keys;
    },
  };
}

/** An object store in memory, for tests and dry runs. */
export function memoryObjectStore(): ObjectStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    put: async (k, b) => void objects.set(k, b),
    get: async (k) => objects.get(k) ?? null,
    list: async (p) => [...objects.keys()].filter((k) => k.startsWith(p)).sort(),
  };
}

const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const hashOf = (text: string) => Bun.hash(text).toString(36);
const lines = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
const parseLines = <T>(text: string): T[] =>
  text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

export class Shared {
  private readonly store: Store;
  private readonly objects: ObjectStore;
  readonly machine: string;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private inflight: Promise<SyncResult> | null = null;

  constructor(opts: SharedOptions) {
    if (!KEY_SAFE.test(opts.machine)) throw new Error(`machine name "${opts.machine}" cannot name a directory in the shared store (letters, digits, . _ -)`);
    this.store = opts.store;
    this.objects = opts.objects;
    this.machine = opts.machine;
    this.intervalMs = opts.intervalMs ?? 30 * 60_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  lastSyncAt(): number | null {
    const v = Number(this.store.getMeta(`${META}last`) ?? 0);
    return v || null;
  }

  /** Publish then pull; skipped (unless forced) while the last sync is younger than the interval. One at a time. */
  sync(force = false): Promise<SyncResult> {
    if (!force && this.now() - (this.lastSyncAt() ?? 0) < this.intervalMs) return Promise.resolve({ published: [], pulled: this.machines(), skipped: true });
    if (!this.inflight)
      this.inflight = this.doSync().finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async doSync(): Promise<SyncResult> {
    const published = await this.publish();
    const pulled = await this.pull();
    this.store.setMeta(`${META}last`, String(this.now()));
    return { published, pulled, skipped: false };
  }

  /** This machine's own rows, as files; only what changed is written. Returns the paths written. */
  async publish(): Promise<string[]> {
    const x = this.store.exportSince(0);
    const files = new Map<string, { text: string; rows: number }>();
    const byDay = new Map<string, TurnRow[]>();
    for (const t of x.turns) (byDay.get(dayOf(t.ts)) ?? byDay.set(dayOf(t.ts), []).get(dayOf(t.ts))!).push(t);
    for (const [day, rows] of byDay) files.set(`turns/${day}.jsonl`, { text: lines(rows), rows: rows.length });
    files.set("sessions.jsonl", { text: lines(x.sessions), rows: x.sessions.length });
    files.set("agents.jsonl", { text: lines(x.agents), rows: x.agents.length });

    // What this machine published last, under this name; a renamed machine starts over in its new directory.
    const recorded = this.readManifest(this.store.getMeta(`${META}published`));
    const previous = recorded?.machine === this.machine ? recorded : null;
    const manifest: Manifest = { machine: this.machine, updatedAt: this.now(), files: {} };
    const written: string[] = [];
    for (const [path, f] of files) {
      const hash = hashOf(f.text);
      manifest.files[path] = { hash, rows: f.rows };
      if (previous?.files[path]?.hash === hash) continue;
      await this.objects.put(`${this.machine}/${path}`, f.text);
      written.push(path);
    }
    if (written.length || !previous) {
      await this.objects.put(`${this.machine}/manifest.json`, JSON.stringify(manifest));
      this.store.setMeta(`${META}published`, JSON.stringify(manifest));
      if (written.length) this.log(`shared: published ${written.length} file(s) as ${this.machine}`);
    }
    return written;
  }

  /** Every other machine's changed files, imported under that machine's name. */
  async pull(): Promise<SharedMachine[]> {
    let keys: string[];
    try {
      keys = await this.objects.list("");
    } catch (e) {
      this.log(`shared: list failed: ${(e as Error).message}`);
      return this.machines();
    }
    const names = [...new Set(keys.filter((k) => k.endsWith("/manifest.json")).map((k) => k.slice(0, -"/manifest.json".length)))].filter((n) => n !== this.machine && KEY_SAFE.test(n));
    for (const name of names) {
      const prev = this.machineState(name);
      try {
        const text = await this.objects.get(`${name}/manifest.json`);
        const manifest = this.readManifest(text);
        if (!manifest) throw new Error("manifest unreadable");
        const seen = this.readManifest(this.store.getMeta(`${META}seen:${name}`)) ?? { machine: name, updatedAt: 0, files: {} };
        let rows = 0;
        for (const [path, f] of Object.entries(manifest.files)) {
          if (seen.files[path]?.hash === f.hash) continue;
          const body = await this.objects.get(`${name}/${path}`);
          if (body === null) throw new Error(`${path} is listed but missing`);
          const x: Export = { sessions: [], turns: [], agents: [] };
          if (path.startsWith("turns/")) x.turns = parseLines<TurnRow>(body);
          else if (path === "sessions.jsonl") x.sessions = parseLines<SessionRow>(body);
          else if (path === "agents.jsonl") x.agents = parseLines<AgentRow>(body);
          else continue;
          this.store.import(name, x);
          rows += x.turns.length + x.sessions.length + x.agents.length;
          seen.files[path] = f;
        }
        seen.updatedAt = manifest.updatedAt;
        this.store.setMeta(`${META}seen:${name}`, JSON.stringify(seen));
        this.setMachineState(name, { updatedAt: manifest.updatedAt, pulledAt: this.now(), ok: true, error: null, rows });
        if (rows) this.log(`shared: pulled ${rows} row(s) from ${name}`);
      } catch (e) {
        const error = String((e as Error).message ?? e).slice(0, 200);
        this.setMachineState(name, { updatedAt: prev?.updatedAt ?? null, pulledAt: prev?.pulledAt ?? null, ok: false, error, rows: 0 });
        this.log(`shared: ${name}: ${error}`);
      }
    }
    return this.machines();
  }

  private readManifest(text: string | null): Manifest | null {
    if (!text) return null;
    try {
      const m = JSON.parse(text) as Manifest;
      if (typeof m !== "object" || m === null || typeof m.files !== "object" || m.files === null) return null;
      return { machine: String(m.machine ?? ""), updatedAt: Number(m.updatedAt) || 0, files: m.files };
    } catch {
      return null;
    }
  }

  machineState(name: string): SharedMachine | null {
    const raw = this.store.getMeta(`${META}machine:${name}`);
    if (!raw) return null;
    try {
      return { name, ...(JSON.parse(raw) as Omit<SharedMachine, "name">) };
    } catch {
      return null;
    }
  }

  private setMachineState(name: string, s: Omit<SharedMachine, "name">): void {
    this.store.setMeta(`${META}machine:${name}`, JSON.stringify(s));
  }

  /** Every machine ever pulled from the store, with its last outcome. */
  machines(): SharedMachine[] {
    return Object.keys(this.store.metaWithPrefix(`${META}machine:`))
      .map((n) => this.machineState(n))
      .filter((s): s is SharedMachine => s !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
