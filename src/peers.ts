import type { Export, Store } from "./store.ts";

/**
 * Other machines' usage, pulled into this store so every view is computed one
 * way. Two ways to find a peer's ai-usage:
 *
 *   - through ai-space: when this service runs inside a space that merges peer
 *     machines (SPACE_API_URL is set), `GET /api/apps?all=1` lists the ai-usage
 *     of every peer, and `GET /api/peers/<peer>/apps/ai-usage/proxy/api/export`
 *     reaches it over the space's own peer channel (token, tunnel, access layer
 *     all handled there). Zero configuration.
 *   - by URL: USAGE_PEERS=name=http://host:port,... names ai-usage instances
 *     reachable directly (an ssh tunnel, a LAN). For a standalone setup.
 *
 * A pull asks for rows since the newest turn already held for that machine,
 * minus an overlap that covers usage still being written when it was last
 * read. Rows are upserted, so the overlap costs nothing but bytes.
 */

export const APP_NAME = "ai-usage";
const OVERLAP_MS = 2 * 86_400_000;
const META_PREFIX = "peer:";

export type PeerSource = { name: string; url: string };
export type PeerState = { name: string; lastPullAt: number | null; ok: boolean; error: string | null; turns: number };

export type PeerOptions = {
  store: Store;
  /** `SPACE_API_URL`, when ai-space runs this service. */
  spaceApiUrl?: string;
  /** `USAGE_PEERS`, parsed. */
  direct?: PeerSource[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
};

/** `name=url,name2=url2`; names are what the machine is called on the dashboard. */
export function parsePeerList(text: string | undefined): PeerSource[] {
  const out: PeerSource[] = [];
  for (const part of (text ?? "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) throw new Error(`USAGE_PEERS entry "${p}" must be name=url`);
    const name = p.slice(0, eq).trim();
    const url = p.slice(eq + 1).trim().replace(/\/+$/, "");
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`USAGE_PEERS name "${name}" must be letters, digits, . _ -`);
    if (!/^https?:\/\//.test(url)) throw new Error(`USAGE_PEERS url for "${name}" must start with http:// or https://`);
    out.push({ name, url });
  }
  return out;
}

export class Peers {
  private readonly store: Store;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private inflight: Promise<PeerState[]> | null = null;

  constructor(private readonly opts: PeerOptions) {
    this.store = opts.store;
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  get enabled(): boolean {
    return !!this.opts.spaceApiUrl || (this.opts.direct?.length ?? 0) > 0;
  }

  /** The peers known right now: the space's list (asked each time) plus the configured URLs. */
  async discover(): Promise<PeerSource[]> {
    const found: PeerSource[] = [...(this.opts.direct ?? [])];
    const base = this.opts.spaceApiUrl?.replace(/\/+$/, "");
    if (base) {
      const r = await this.fetchFn(`${base}/api/apps?all=1`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!r.ok) throw new Error(`space answered ${r.status} to /api/apps`);
      const j = (await r.json()) as { apps?: { name?: string; peer?: string }[] };
      for (const a of j.apps ?? [])
        if (a.name === APP_NAME && a.peer && !found.some((f) => f.name === a.peer)) found.push({ name: a.peer, url: `${base}/api/peers/${encodeURIComponent(a.peer)}/apps/${APP_NAME}/proxy` });
    }
    return found;
  }

  /** Pull every peer once; one pull at a time, callers arriving meanwhile share it. */
  pullAll(): Promise<PeerState[]> {
    if (!this.inflight)
      this.inflight = this.doPullAll().finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async doPullAll(): Promise<PeerState[]> {
    let peers: PeerSource[];
    try {
      peers = await this.discover();
    } catch (e) {
      this.log(`peers: discovery failed: ${(e as Error).message}`);
      return this.states();
    }
    for (const p of peers) {
      try {
        const n = await this.pull(p);
        this.setState(p.name, { ok: true, error: null, lastPullAt: this.now(), turns: n });
        if (n) this.log(`peers: ${p.name}: ${n} turns`);
      } catch (e) {
        const error = String((e as Error).message ?? e).slice(0, 200);
        const prev = this.state(p.name);
        this.setState(p.name, { ok: false, error, lastPullAt: prev?.lastPullAt ?? null, turns: 0 });
        this.log(`peers: ${p.name}: ${error}`);
      }
    }
    return this.states();
  }

  private async pull(p: PeerSource): Promise<number> {
    const since = Math.max(0, this.store.latestTurn(p.name) - OVERLAP_MS);
    const r = await this.fetchFn(`${p.url}/api/export?since=${since}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!r.ok) throw new Error(`${p.url} answered ${r.status}`);
    const j = (await r.json()) as Partial<Export> & { ok?: boolean; error?: string };
    if (j.ok !== true) throw new Error(j.error || "not an export");
    if (!Array.isArray(j.sessions) || !Array.isArray(j.turns) || !Array.isArray(j.agents)) throw new Error("export has no rows");
    this.store.import(p.name, { sessions: j.sessions, turns: j.turns, agents: j.agents });
    return j.turns.length;
  }

  state(name: string): PeerState | null {
    const raw = this.store.getMeta(META_PREFIX + name);
    if (!raw) return null;
    try {
      return { name, ...(JSON.parse(raw) as Omit<PeerState, "name">) };
    } catch {
      return null;
    }
  }

  private setState(name: string, s: Omit<PeerState, "name">): void {
    this.store.setMeta(META_PREFIX + name, JSON.stringify(s));
  }

  /** Every peer ever pulled, with its last outcome. */
  states(): PeerState[] {
    return Object.entries(this.store.metaWithPrefix(META_PREFIX))
      .map(([name]) => this.state(name))
      .filter((s): s is PeerState => s !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
