import { hostname } from "node:os";
import index from "../web/index.html";
import { loadConfig } from "./config.ts";
import { Limits } from "./limits.ts";
import { Peers, parsePeerList } from "./peers.ts";
import { shortModel } from "./pricing.ts";
import { scanSpaceLedger } from "./space-ledger.ts";
import { scanSources } from "./scanner.ts";
import { createApp } from "./server.ts";
import { Shared, objectStoreFromEnv } from "./shared.ts";
import { type Range, RANGES, summary } from "./stats.ts";
import { Store } from "./store.ts";

/**
 * ai-usage entry point.
 *
 *   bun src/index.ts               serve the dashboard on 127.0.0.1:$PORT (scans on boot and every USAGE_SCAN_INTERVAL; syncs the shared
 *                                  store every USAGE_SYNC_INTERVAL, or pulls peers after each scan when there is no store)
 *   bun src/index.ts scan          read new transcript lines into the cache, sync the shared store or pull the peers, and exit
 *   bun src/index.ts today         print today's usage by model
 *   bun src/index.ts stats [range] print totals, models, machines and projects for a range (7d by default; see RANGES)
 *
 * The machine's name on the dashboard (and in the shared store) is USAGE_MACHINE, else SPACE_NAME, else the hostname.
 * USAGE_ROLE=collector makes this instance scan and publish only: no page, no pulls (config.ts).
 * Plan usage limits are read with the CLI's own login when this machine has one (limits.ts), every five minutes.
 */

const log = (line: string) => console.log(`[ai-usage] ${line}`);
const fmt = (n: number) => n.toLocaleString("en-US");
const cost = (c: number | null) => (c === null ? "n/a" : `$${c.toFixed(2)}`);

async function main(): Promise<void> {
  const config = loadConfig();
  const machine = process.env.USAGE_MACHINE?.trim() || process.env.SPACE_NAME?.trim() || hostname();
  const store = new Store(config.dbPath);
  const peers = new Peers({ store, spaceApiUrl: process.env.SPACE_API_URL?.trim() || undefined, direct: parsePeerList(process.env.USAGE_PEERS), log });
  const objects = objectStoreFromEnv(process.env);
  const syncInterval = Number(process.env.USAGE_SYNC_INTERVAL ?? 1800);
  if (!Number.isFinite(syncInterval) || syncInterval < 60) throw new Error(`USAGE_SYNC_INTERVAL must be at least 60 seconds, got ${process.env.USAGE_SYNC_INTERVAL}`);
  const shared = objects ? { url: objects.url, shared: new Shared({ store, objects: objects.objects, machine, intervalMs: syncInterval * 1000, publishOnly: config.role === "collector", log }) } : undefined;
  const command = process.argv[2] ?? "serve";
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const scan = async () => {
    const result = await scanSources(store, config.sources, { log });
    if (config.ledger) {
      result.ledger = await scanSpaceLedger(store, config.ledger, machine);
      if (result.ledger.error) log(result.ledger.error);
      if (result.ledger.imported) log(`Space ledger: imported ${result.ledger.imported} Codex calls`);
      result.turns += result.ledger.imported;
      result.sessions += result.ledger.imported;
    }
    return result;
  };

  if (command === "scan") {
    const r = await scan();
    log(`sources: ${r.sources.join(", ") || "(none found)"}`);
    log(`${r.files} files · ${r.newFiles} new · ${r.updatedFiles} updated · ${r.turns} turns read · ${r.ms} ms`);
    if (shared) {
      const r = await shared.shared.sync(true);
      log(`shared store ${shared.url}: published ${r.published.length} file(s)`);
      for (const m of r.pulled) log(`  ${m.name}: ${m.ok ? `${m.rows} new row(s)` : m.error}`);
    } else if (peers.enabled) for (const p of await peers.pullAll()) log(`peer ${p.name}: ${p.ok ? `${p.turns} turns` : p.error}`);
    const c = store.counts();
    log(`cache: ${c.turns} turns in ${c.sessions} sessions from ${c.files} files (${config.dbPath})`);
    store.close();
    return;
  }

  if (command === "today" || command === "stats") {
    await scan();
    const range = command === "today" ? "today" : ((process.argv[3] ?? "7d") as Range);
    if (!RANGES.includes(range)) throw new Error(`range must be one of ${RANGES.join(", ")}`);
    const s = summary(store, { range, tz });
    const t = s.totals;
    console.log(`${range} (${tz}) · ${fmt(t.tokens)} tokens · ${cost(t.cost)} · ${t.sessions} sessions · ${t.turns} turns`);
    console.log(`  input ${fmt(t.input)} · output ${fmt(t.output)} · cache read ${fmt(t.cacheRead)} · cache write ${fmt(t.cacheWrite)}`);
    if (s.byModel.length) {
      console.log("by model");
      for (const m of s.byModel) console.log(`  ${shortModel(m.model).padEnd(16)} ${fmt(m.tokens).padStart(14)} tokens ${cost(m.cost).padStart(10)} ${String(m.turns).padStart(7)} turns`);
    }
    if (command === "stats") {
      if (s.byMachine.length > 1) {
        console.log("by machine");
        for (const m of s.byMachine) console.log(`  ${(m.machine || machine).padEnd(16)} ${fmt(m.tokens).padStart(14)} tokens ${cost(m.cost).padStart(10)} ${String(m.sessions).padStart(5)} sessions`);
      }
      if (s.byProject.length) {
        console.log("by project");
        for (const p of s.byProject.slice(0, 15)) console.log(`  ${`${p.machine ? `${p.machine}/` : ""}${p.project}`.slice(0, 40).padEnd(40)} ${fmt(p.tokens).padStart(14)} tokens ${cost(p.cost).padStart(10)} ${String(p.sessions).padStart(5)} sessions`);
      }
    }
    store.close();
    return;
  }

  if (command !== "serve") throw new Error(`unknown command: ${command} (expected serve, scan, today or stats)`);

  const limits = new Limits({ machine, log, publishOnly: config.role === "collector", ...(objects ? { objects: objects.objects, others: () => shared!.shared.machines().map((m) => m.name) } : {}) });
  const codexLimits = new Limits({ provider: "codex", machine, log, publishOnly: config.role === "collector", ...(objects ? { objects: objects.objects, others: () => shared!.shared.machines().map((m) => m.name) } : {}) });
  const app = createApp({ store, config, machine, page: index, scan, peers, limits, codexLimits, log, ...(shared ? { shared } : {}) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: config.port, routes: app.routes as never, development: !!process.env.SPACE_DEV });
  log(`listening on http://127.0.0.1:${server.port} · ${machine} (${config.role}) · cache ${config.dbPath} · sources ${config.sources.join(", ")}${shared ? ` · shared store ${shared.url} every ${syncInterval} s` : peers.enabled ? " · peers on" : ""}`);
  const tick = () => app.refresh(false).catch((e) => log(`refresh failed: ${(e as Error).message}`));
  tick();
  const timer = setInterval(tick, config.scanIntervalMs);
  // The limits keep their own clock (five minutes between fetches); this only asks whether one is due.
  limits.tick();
  codexLimits.tick();
  const limitsTimer = setInterval(() => { limits.tick(); codexLimits.tick(); }, 60_000);

  const stop = () => {
    clearInterval(timer);
    clearInterval(limitsTimer);
    server.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  console.error(`[ai-usage] ${(e as Error).message}`);
  process.exit(1);
});
