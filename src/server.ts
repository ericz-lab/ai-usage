import type { Config } from "./config.ts";
import type { Peers } from "./peers.ts";
import { PRICING_AS_OF } from "./pricing.ts";
import type { ScanResult } from "./scanner.ts";
import type { Shared } from "./shared.ts";
import { RANGES, type Range, summary, validTz } from "./stats.ts";
import type { Store } from "./store.ts";

/**
 * The service. Contract (ai-space docs/app-spec.md, "service"): read PORT,
 * bind 127.0.0.1 only, answer GET /healthz with 200, log to stdout, exit on
 * SIGTERM within 10 s.
 *
 *   GET  /                       the dashboard
 *   GET  /healthz                200 once the store is open
 *   GET  /api/status             machine name, sources, files, turns, sessions, last scan, shared store and peers
 *   GET  /api/summary            ?range=7d&models=a,b&machines=x,y&tz=Asia/Tokyo -> stats.ts Summary
 *                                (scans first when the last scan is stale; `machines` uses the names the page shows)
 *   POST /api/refresh            scan now, sync the shared store (or pull every peer); returns what changed
 *   GET  /api/export?since=<ms>  this machine's own rows from `since` on, for a hub that pulls them
 *   GET  /api/widget             ai-space panel card: today, last 7 days, top model
 *
 * Reads trust loopback; there is no token (the edge holds the login, and a
 * peer's export is reached through the space's authenticated peer channel).
 *
 * A collector (USAGE_ROLE=collector) serves only /healthz, /api/status,
 * /api/refresh and /api/export: it scans and publishes, and the page, the
 * summary and the widget answer 404 with a line saying where the dashboard is.
 */

export const VERSION = "0.1.0";

export type ServerOptions = {
  store: Store;
  config: Config;
  /** How this machine is named on the dashboard. */
  machine: string;
  scan: () => Promise<ScanResult>;
  /** The shared store, when BLOB_URL is an s3 prefix; it wins over peers. */
  shared?: { url: string; shared: Shared };
  /** Direct or space-discovered peers; used when there is no shared store. */
  peers?: Peers;
  /** The page module (Bun HTML import); omitted in tests. */
  page?: unknown;
  /** Reads run a scan first when the last one is older than this. */
  freshMs?: number;
  now?: () => number;
  log?: (line: string) => void;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const fmtTokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(n));
const fmtCost = (c: number | null) => (c === null ? "n/a" : c >= 100 ? `$${c.toFixed(0)}` : c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(3)}`);
const list = (v: string | null) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function createApp(opts: ServerOptions) {
  const { store, config, machine } = opts;
  const now = opts.now ?? Date.now;
  const freshMs = opts.freshMs ?? 60_000;
  const log = opts.log ?? ((l: string) => console.log(`[ai-usage] ${l}`));
  let inflight: Promise<ScanResult> | null = null;
  let last: ScanResult | null = null;

  /** One scan at a time; callers arriving during a scan share it. */
  const scan = (): Promise<ScanResult> => {
    if (!inflight)
      inflight = opts
        .scan()
        .then((r) => {
          last = r;
          if (r.newFiles || r.updatedFiles) log(`scan: ${r.files} files, ${r.newFiles} new, ${r.updatedFiles} updated, ${r.turns} turns, ${r.ms} ms`);
          return r;
        })
        .finally(() => {
          inflight = null;
        });
    return inflight;
  };
  /** Scan here, then sync the shared store (throttled unless forced) or pull the peers; their failures are recorded, not thrown. */
  const refresh = async (force = true): Promise<ScanResult> => {
    const r = await scan();
    if (opts.shared) await opts.shared.shared.sync(force);
    else if (opts.peers?.enabled) await opts.peers.pullAll();
    return r;
  };
  const lastScanAt = (): number => Number(store.getMeta("last_scan") ?? 0);
  const ensureFresh = async (): Promise<void> => {
    if (now() - lastScanAt() > freshMs) await scan();
  };

  /** The page names this machine; the store calls it ''. */
  const toStore = (names: string[]) => names.map((n) => (n === machine ? "" : n));
  const fromStore = (name: string) => name || machine;

  const status = () => ({
    ok: true,
    version: VERSION,
    machine,
    role: config.role,
    pricingAsOf: PRICING_AS_OF,
    sources: config.sources,
    ...store.counts(),
    lastScan: lastScanAt() || null,
    scanning: inflight !== null,
    last,
    shared: opts.shared ? { url: opts.shared.url, lastSyncAt: opts.shared.shared.lastSyncAt(), machines: opts.shared.shared.machines() } : null,
    peers: opts.shared ? [] : (opts.peers?.states() ?? []),
    peersEnabled: !opts.shared && (opts.peers?.enabled ?? false),
  });

  const routes: Record<string, unknown> = {
    "/healthz": () => new Response("ok"),
    "/api/status": { GET: () => json(status()) },
    "/api/summary": {
      GET: async (req: Request) => {
        const u = new URL(req.url);
        const range = (u.searchParams.get("range") ?? "7d") as Range;
        if (!RANGES.includes(range)) return json({ ok: false, error: `range must be one of ${RANGES.join(", ")}` }, 400);
        await ensureFresh();
        const s = summary(store, { range, models: list(u.searchParams.get("models")), machines: toStore(list(u.searchParams.get("machines"))), tz: validTz(u.searchParams.get("tz") ?? undefined), now: now() });
        return json({
          ok: true,
          ...s,
          machines: s.machines.map((m) => ({ ...m, machine: fromStore(m.machine) })),
          selectedMachines: s.selectedMachines.map(fromStore),
          byMachine: s.byMachine.map((m) => ({ ...m, machine: fromStore(m.machine) })),
          byProject: s.byProject.map((p) => ({ ...p, machine: fromStore(p.machine) })),
          byBranch: s.byBranch.map((b) => ({ ...b, machine: fromStore(b.machine) })),
          sessions: s.sessions.map((x) => ({ ...x, machine: fromStore(x.machine) })),
          dispatches: s.dispatches.map((d) => ({ ...d, machine: fromStore(d.machine) })),
        });
      },
    },
    "/api/refresh": {
      POST: async () => {
        const scanned = await refresh(true);
        return json({ ...status(), scan: scanned });
      },
    },
    "/api/export": {
      GET: async (req: Request) => {
        const since = Number(new URL(req.url).searchParams.get("since") ?? 0);
        if (!Number.isFinite(since) || since < 0) return json({ ok: false, error: "since must be a millisecond timestamp" }, 400);
        await ensureFresh();
        return json({ ok: true, machine, ...store.exportSince(since) });
      },
    },
    "/api/widget": {
      GET: async (req: Request) => {
        try {
          await ensureFresh();
          const tz = validTz(new URL(req.url).searchParams.get("tz") ?? undefined);
          const today = summary(store, { range: "today", tz, now: now(), sessionLimit: 1 });
          const week = summary(store, { range: "7d", tz, now: now(), sessionLimit: 1 });
          const top = week.byModel[0];
          const at = new Date(now()).toISOString();
          const machines = week.byMachine.length > 1 ? ` · ${week.byMachine.length} machines` : "";
          return json({
            ok: true,
            items: [
              { text: `Today · ${fmtTokens(today.totals.tokens)} tokens · ${fmtCost(today.totals.cost)} · ${today.totals.sessions} sessions`, url: "/?range=today", time: at },
              { text: `7 days · ${fmtTokens(week.totals.tokens)} tokens · ${fmtCost(week.totals.cost)} · ${fmtCost(week.totals.perDay.cost)} per day${machines}`, url: "/?range=7d", time: at },
              ...(top ? [{ text: `Top model · ${top.model} · ${fmtTokens(top.tokens)} tokens in 7 days`, url: "/?range=7d" }] : []),
            ],
          });
        } catch (e) {
          return json({ ok: false, error: (e as Error).message });
        }
      },
    },
  };
  if (config.role === "collector") {
    const off = () => new Response(`ai-usage on ${machine} is a collector: it scans and publishes; open the dashboard on the machine that has one.\n`, { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    delete routes["/api/summary"];
    delete routes["/api/widget"];
    routes["/"] = off;
    routes["/api/summary"] = off;
    routes["/api/widget"] = off;
    return { routes, scan, refresh, status };
  }
  if (opts.page) routes["/"] = opts.page;
  routes["/icon.svg"] = () => new Response(Bun.file(new URL("../icon.svg", import.meta.url)), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });

  return { routes, scan, refresh, status };
}
