# ai-usage

**What Claude Code and Codex spent, on this machine and the others, from the CLI's own transcripts.**

Claude Code writes a JSONL transcript for every session under `~/.claude/projects`, whatever the plan: each model response carries its model and the four token counts (input, output, cache write, cache read). ai-usage reads those files, keeps the numbers in a small SQLite cache and shows them as a dashboard: tokens and cost estimates by day, by hour, by model, by project and branch, by session, by subagent type, and by machine.

Codex history comes from `~/.codex/sessions` and `~/.codex/archived_sessions` (or the same directories under `CODEX_HOME`). Its token records feed the same charts, filters, project/session tables, widget and shared-store sync. No subscription login is needed to read local history. ai-space Codex tasks that use ephemeral CLI sessions (translation, summaries, and similar calls) are imported from the local Space usage ledger.

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

The usage endpoint is undocumented; unexpected responses appear as an unavailable reading rather than invented usage.

## Codex historical tokens and costs

The parser follows [CodexBar's local history approach](https://github.com/steipete/CodexBar/blob/main/docs/codex.md): `session_meta` identifies the session/project/branch, `turn_context` selects the model, and `event_msg` / `token_count` supplies per-request and cumulative usage. Repeated cumulative snapshots and the duplicate `token_usage_record` representation are not counted again. Input already includes cached tokens, so cache reads/writes are split out; reasoning tokens already belong to output. Explicit child history ordinals (or fork timestamps for older logs) exclude inherited context. Unattributed models remain `codex-unknown` and unpriced.

Only appended bytes are parsed after the initial scan. Model and counter state survive service restarts; incomplete trailing lines wait until settled. Stable session/event IDs prevent archive moves, copied files and shared-store imports from counting usage again. Only normalized usage and session metadata are shared, not prompt or response bodies. Explicit `USAGE_SOURCES` replaces the default directories; include both Codex directories if you use this setting.

GPT rates are maintained by **ai-space**, in its `src/space/model/gpt-prices.json`. ai-usage reads `GET /api/model/pricing` from `SPACE_API_URL` (default `http://127.0.0.1:8700`) on boot, during scans and before summary/widget reads, at most once a minute. Refresh forces a new fetch. There is no embedded GPT price table in this app.

The catalogue specifies its version, verification date, USD unit size, model rates, long-context thresholds/multipliers and optional Fast multiplier. The same rates power ai-space's Model usage. A successful response is cached in usage.db per source URL and survives restarts. On a timeout, invalid response or older ai-space without this endpoint, the last valid catalogue remains usable. With no valid catalogue, GPT costs show n/a; scanning and Claude costs still work. `/api/status` exposes `gptPricing` (source URL, date, fetch time, live/cached/unavailable state and error).

Costs use the current catalogue, including for historical rows. Input categories stay separate; long-context rules apply per recorded request, and explicit priority/fast tiers use the catalogue multiplier. Unknown models, unsupported tiers or unavailable cache-write prices stay unpriced. These are API-equivalent estimates, not subscription fees or invoices; tool and regional charges are not inferred.

## ai-space Codex tasks

ai-space executes one-shot Codex completions with `--ephemeral`, so they have no session JSONL to scan. ai-usage also opens the **local** Space `model_calls` ledger read-only and imports those calls, including all retained history on first run. This needs no changes to ai-space and no additional dependencies.

The default ledger is `$SPACE_DB`, otherwise `<workspace>/data/space.db`. The workspace is `$SPACE_HOME`, inferred from `SPACE_APP_DATA_DIR` when running as an app, or `~/.ai-space`. Override with `USAGE_SPACE_DB=/path/to/space.db`; `USAGE_SPACE_DB=none` disables it. A missing ledger is silently skipped so standalone installations still work. `USAGE_SOURCES` controls transcript directories only.

Runtime names are discovered from entries with `kind: codex-cli` in `<workspace>/runtimes.yaml`. `USAGE_CODEX_RUNTIMES=codex,retired-codex` overrides discovery and can include retired names; only list runtimes that actually used the Codex CLI. Only `origin=run` rows are imported: imported history, persistent agent tasks and other runtime kinds are excluded to avoid counting transcript-backed usage twice. Calls without token counts are skipped; failed calls with recorded consumption still count.

Each call appears as a session under project `ai-space/<app>`; the session topic identifies the task tag (for example `translate`), runtime and execution backend. An SSH call belongs to the Space machine that requested it and holds the ledger, even when another machine supplied the Codex login. The existing model/machine filters, charts, cost estimates, export and shared-store sync all include these rows.

Space already separates input and cached tokens, so these counts are imported directly. Costs remain API-equivalent estimates using the dashboard price table; the ledger does not preserve per-internal-request context sizes or Fast tier, so exact CLI billing cannot be reconstructed. IDs include the source machine, ledger call id and start time; repeated scans and shared-store imports cannot duplicate a call. The cursor follows insertion IDs, allowing late-finishing calls with older start timestamps to be backfilled. A source anchor detects ledger replacement or retention changes and allows safe replay. Keep machine names unique and retain the authoritative ledger if you need to rebuild this history.

Imports run alongside transcript scans on boot, scheduled refresh, manual Refresh and CLI `scan`/`today`/`stats`. `/api/status` exposes the latest import count or error in `last.ledger`. No prompts, responses, credentials or ledger error text are imported into usage rows.
