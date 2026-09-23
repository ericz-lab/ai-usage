# ai-usage

**What Claude Code spent, on this machine and the others, from the CLI's own transcripts.**

Claude Code writes a JSONL transcript for every session under `~/.claude/projects`, whatever the plan: each model response carries its model and the four token counts (input, output, cache write, cache read). ai-usage reads those files, keeps the numbers in a small SQLite cache and shows them as a dashboard: tokens and cost estimates by day, by hour, by model, by project and branch, by session, by subagent type, and by machine.

It is an [ai-space](https://github.com/ericz-lab/ai-space) app and ships with it as a default app: a fresh space installs it on `init`. It also runs on its own with `bun src/index.ts`.

The idea and the transcript format notes come from [phuryn/claude-usage](https://github.com/phuryn/claude-usage), which does the same for one machine in Python. ai-usage adds the multi-machine part and the ai-space integration.

## What it shows

- **Range**: 5 hours (a subscription's rolling window), today, 7, 30, 90 days, all time; in the viewer's time zone.
- **Filters**: models (colours follow the model, not its rank, so a filter never repaints the survivors) and machines.
- **Plan usage limits**: Claude and Codex subscription usage, with session/weekly percentages and reset times. Codex also shows model-specific windows when supplied by the API. Each provider refreshes every five minutes; shared storage keeps the newest reading per provider/account.
- **Tiles**: tokens (with the subagents' share), estimated cost, sessions, turns, per-day average.
- **Charts**: daily usage stacked by model, hourly distribution (average per active day), by model, by machine, top projects, subagents by type. Every mark has a tooltip.
- **Tables**: cost by model with the four token kinds, sessions (project, topic, model, last active, duration, turns, tokens, cost), subagent dispatches, cost by project, cost by project and branch. Sortable, collapsible, the long ones fold.
- **Widget**: an ai-space panel card with today, the last seven days, the top model and the plan limits.
- English and Chinese (`?lang=`), light and dark (`?theme=`, else the OS setting).

## Multi-machine

Every machine runs the same ai-usage over its own transcripts. They share data through **one S3 prefix** (Cloudflare R2 or any S3-compatible bucket): each instance publishes its own rows under `<prefix>/<machine>/` (one file per day of turns, plus sessions and agents, and a manifest of content hashes) and reads every other machine's files whose hash changed. Machines never need to reach each other, only the bucket; a laptop behind NAT that is online an hour a day takes part like a server. Every view is computed once over one local cache with a machine filter, on whichever machine you open.

- **Inside ai-space** nothing is configured: `space.yaml` declares `storage.blobs: s3`, the space hands the prefix (`s3://<bucket>/ai-usage/`) and credentials over, and every space that shares the bucket shares the data. A space without S3 gets a file store and that instance stays local.
- **A machine outside a space** (a laptop) sets `BLOB_URL`, `S3_*` and `USAGE_MACHINE` in its `.env` to join the same prefix; `deploy/install.sh` installs a launchd agent on macOS so it publishes whenever the machine is awake.

A machine that only feeds the others sets `USAGE_ROLE=collector`: it scans and publishes, never pulls, and serves no page (the dashboard lives on the machine that has one; in ai-space every panel's tile points there through `SPACE_APP_URL_<NAME>`). The default role, `dashboard`, does everything.

Sync runs every 30 minutes (`USAGE_SYNC_INTERVAL`) and on the Refresh button. Publishing rewrites only the files whose content changed (today's, and any day still receiving final tallies); pulling downloads only what changed. A machine that was off for a month catches up in one round.

Without a bucket the older path still works: `USAGE_PEERS=box2=http://127.0.0.1:18880` names ai-usage instances reachable directly, or, inside a space that merges peers, the instance pulls each peer's ai-usage through the space's peer channel. Each instance's `GET /api/export` only ever hands out its own rows, so nothing is counted twice.

## Cost estimates

At Anthropic API list prices as of June 2026 (`src/pricing.ts`), per million tokens:

| Family | Input | Output | Cache write | Cache read |
| --- | --- | --- | --- | --- |
| fable, mythos | $10 | $50 | $12.50 | $1.00 |
| opus | $5 | $25 | $6.25 | $0.50 |
| sonnet | $3 | $15 | $3.75 | $0.30 |
| haiku | $1 | $5 | $1.25 | $0.10 |

A model is priced by the family name its id contains; anything else (local models, `<synthetic>`) shows as n/a, never as zero. On a Pro or Max plan the figure is what the same usage would cost on the API, not a bill.

## Run

```bash
bun install
bun src/index.ts                 # http://127.0.0.1:8880
bun src/index.ts scan            # read new transcript lines into the cache (and pull the peers), then exit
bun src/index.ts today           # today's usage by model, in the terminal
bun src/index.ts stats 30d       # totals, models, machines and projects for a range
```

Environment (`.env.example` lists everything): `PORT`, `DATABASE_URL` or `SPACE_APP_DATA_DIR` for the cache, `USAGE_SOURCES` for other transcript directories, `USAGE_SCAN_INTERVAL`, `USAGE_SYNC_INTERVAL`, `USAGE_MACHINE` (else `SPACE_NAME`, else the hostname), `BLOB_URL` and `S3_*` for the shared store, `USAGE_PEERS`, `SPACE_API_URL` (set by ai-space).

## Inside ai-space

`space.yaml` declares the service (port 8880, `/healthz`), the widget, a SQLite database and the shared store (`blobs: { backend: s3, fallback: file }`). ai-space installs it as a default app on `init`: clone into `~/.ai-space/apps/ai-usage`, then `deploy/install.sh` (dependencies, a user-level systemd unit, start). On a machine with a hostname, set `SPACE_APP_URL_AI_USAGE=https://usage.<domain>/?lang={lang}` in the workspace `.env` so the panel tile opens the public address; the manifest itself names loopback, which is right on a laptop. Git-push deploys work like any other app with `deploy/post-receive`.

## API

| Route | |
| --- | --- |
| `GET /api/summary?range=7d&models=a,b&machines=x,y&tz=Asia/Tokyo` | everything the page shows |
| `GET /api/status` | machine, role, sources, counts, last scan, shared store, peers |
| `POST /api/refresh` | scan now, sync the shared store (or pull the peers), re-read the plan limits |
| `GET /api/limits` | plan usage limits: the newest reading per account |
| `GET /api/export?since=<ms>` | this machine's own rows, for a peer pull |
| `GET /api/widget` | the panel card |
| `GET /healthz` | 200 |

Reads trust loopback; there is no token. Exposure is the space's job (a tunnel with a login in front).

## Not captured

Sessions that run server-side and write no local transcript (Claude's cloud sessions), and calls made through the Anthropic API directly. Calls an app makes through ai-space's model service on this machine do write transcripts (they run the CLI) and are counted; the space's own model ledger stays the place to see them by app and purpose.

## License

MIT.

## Codex subscription usage

The integration follows [CodexBar's OAuth usage source](https://github.com/steipete/CodexBar/blob/main/docs/codex.md): read `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) and request `https://chatgpt.com/backend-api/wham/usage` with the access token and `ChatGPT-Account-Id`. Log in with `codex login` on the machine running ai-usage. API-key-only authentication does not provide subscription limits.

Credentials are read on each poll and never refreshed or rewritten. If the token expires, renew it through Codex; `/api/status` exposes `codexLimits` with the latest result. Failed requests retain the last successful snapshot and its original timestamp. No token is returned by the API or published to shared storage. Codex snapshots use `<machine>/limits-codex.json`; Claude keeps `<machine>/limits.json`, so older collectors remain compatible. Each provider/account is deduplicated independently. Collector instances publish both providers without serving the dashboard.

This adds subscription quota bars, not Codex transcript token counts or cost estimates. Token/cost charts still describe Claude transcripts. The usage endpoint is undocumented; unexpected responses appear as an unavailable reading rather than invented usage.
