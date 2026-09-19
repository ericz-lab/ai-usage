# ai-usage - agent guide

Read this before touching code. Users read [README.md](README.md). This repository is an ai-space app; the contract is ai-space `docs/app-spec.md` (spec 1) and `space.yaml` is the only file ai-space reads. It is also a default app of ai-space: a fresh space clones and installs it on `init`, so it must always run with no `.env` and no configuration.

## Rules

1. **The transcripts are the truth; the database is a cache.** Nothing is derived that cannot be rebuilt by deleting `usage.db` and scanning again. Never write to the transcript directories.
2. **Count once.** One API response is logged several times while it streams, all with the same `message.id`; the last record wins (`turns` is unique by message id and upserts). Rows pulled from peers keep their ids, so a row has one identity across machines.
3. **Estimate, do not invent.** A model without a listed price shows n/a, never zero; a group with one unpriced member has a null cost. Prices carry their date (`PRICING_AS_OF`).
4. **The viewer's day.** Days and hours are computed in the time zone the page sends (`tz`); "today" is the viewer's today. The math lives in `src/stats.ts` only.
5. **Loopback only, no token.** The service binds `127.0.0.1:${PORT}`; exposure and login are the space's job. A peer's export is reached through the space's authenticated peer channel, never by exposing this port.
6. **Configuration is environment.** `.env.example` lists every variable; real values live in `.env` (ignored) or in the `space.env` ai-space writes.

## Stack and runtime model

- Bun + TypeScript, React 19 for the page, no other dependency. `src/index.ts` is the entry point (`Bun.serve` with the HTML import of `web/index.html`, `bun:sqlite`).
- A scan runs on boot, every `USAGE_SCAN_INTERVAL` seconds, on `POST /api/refresh`, and before any read when the last scan is older than a minute. It is incremental: each file is tracked by size, mtime and the byte offset consumed, and only appended bytes are read (a partial last line waits until the file has been quiet for ten seconds). A full first scan of a year of transcripts takes well under a second per hundred megabytes.
- Peers are pulled after every scan (`src/peers.ts`): discovery through `SPACE_API_URL` (`GET /api/apps?all=1`, entries named `ai-usage` with a `peer`) plus `USAGE_PEERS`; each pull asks `/api/export?since=` from the newest row held for that machine minus two days; results are upserted and the outcome kept in `meta` (`peer:<name>`).
- Runs as the user-level systemd unit `ai-usage` from `~/.ai-space/apps/ai-usage`, port 8880, health `GET /healthz`.

## Directory map

```
space.yaml           * the manifest: identity, service, widget, storage
src/index.ts         * entry point: serve, scan, today, stats
src/scanner.ts       * parseTranscript (pure) and the incremental scanSources
src/store.ts         * bun:sqlite schema, upserts, the queries stats needs, export/import for peers
src/stats.ts         * summary(): one window, one model and machine filter, one time zone -> everything the page shows
src/server.ts        * routes: /api/summary, /api/status, /api/refresh, /api/export, /api/widget, /healthz, /icon.svg
src/peers.ts           peer discovery and pulls
src/pricing.ts         the price table, costOf, shortModel, modelRank
src/config.ts          environment -> config (PORT, DATABASE_URL, USAGE_*)
web/App.tsx          * the page: filters in the URL, collapsed cards in localStorage, 60 s refresh
web/charts.tsx         inline-SVG charts (stacked daily bars, hourly bars, horizontal bars), tooltip, legend
web/api.ts             the JSON types as the page sees them, formatting helpers
web/i18n.ts            English and Chinese; every visible string goes through t()
web/styles.css         tokens for both themes; series colours are the eight validated categorical slots
deploy/app.service     user-level systemd unit template (@DIR@ substituted)
deploy/install.sh      dependencies, unit, start, health check; what ai-space runs after cloning
deploy/post-receive    bare-repository hook for git-push deploys
icon.svg               panel icon, 64x64 viewBox
.env.example           every variable the service reads
```

## Conventions

- Tests sit next to the code (`src/*.test.ts`), use `:memory:` databases, temporary directories and a scripted `fetch`; no network, no real transcripts.
- Widget contract: `GET /api/widget` -> `{ ok: true, items: [{ text, url, time }] }`.
- Export contract: `GET /api/export?since=<ms>` -> `{ ok, machine, sessions, turns, agents }` with the store's row shapes; only rows scanned here (`machine = ''`), never rows pulled from elsewhere, so a chain of hubs cannot double count.
- Series colours: a model's slot is its index in the all-time model list (`summary.models`), not in the filtered one, so filtering never repaints. Past eight slots everything folds into "other".
- English in code, comments, docs and commits; the page is bilingual. Commit messages follow Conventional Commits.

## Commands

```bash
bun install
bun src/index.ts                  # serve on 127.0.0.1:8880
bun src/index.ts scan|today|stats [range]
bun run check                     # typecheck + tests
bash deploy/install.sh            # install the user unit on a server
```

## Environment

| Variable | Meaning | Default |
| --- | --- | --- |
| `PORT` | port on 127.0.0.1 | 8880 |
| `DATABASE_URL` | `sqlite://<path>` of the cache (ai-space sets it) | `$SPACE_APP_DATA_DIR/usage.db`, else `data/usage.db` |
| `USAGE_SOURCES` | comma-separated transcript directories | `~/.claude/projects` and the Xcode integration directory |
| `USAGE_SCAN_INTERVAL` | seconds between scans | 300 |
| `USAGE_MACHINE` | this machine's name on the dashboard | `SPACE_NAME`, else the hostname |
| `USAGE_PEERS` | `name=url,...` of ai-usage instances reachable directly | none |
| `SPACE_API_URL` | the space's API, for peer discovery (ai-space sets it) | none |

## Known pitfalls

- A dispatch record (`toolUseResult` with `agentId` and `agentType`) is not always present; a subagent seen only through its `subagents/agent-<id>.jsonl` file gets type `subagent`, and its project comes from the session of its turns.
- `startOfDay` works from the zone's wall clock; on a DST transition day the boundary may be an hour off. Nothing else depends on it.
- The space's `GET /api/apps?all=1` lists peer apps only once the hub has a snapshot of the peer; right after a boot the first pull may find no peers and the next one (five minutes later) does.
- `SPACE_APP_URL_AI_USAGE` is read by ai-space, not by this service: the tile's link changes, the service does not care.
