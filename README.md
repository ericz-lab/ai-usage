# ai-usage

**What Claude Code spent, on this machine and the others, from the CLI's own transcripts.**

Claude Code writes a JSONL transcript for every session under `~/.claude/projects`, whatever the plan: each model response carries its model and the four token counts (input, output, cache write, cache read). ai-usage reads those files, keeps the numbers in a small SQLite cache and shows them as a dashboard: tokens and cost estimates by day, by hour, by model, by project and branch, by session, by subagent type, and by machine.

It is an [ai-space](https://github.com/ericz-lab/ai-space) app and ships with it as a default app: a fresh space installs it on `init`. It also runs on its own with `bun src/index.ts`.

The idea and the transcript format notes come from [phuryn/claude-usage](https://github.com/phuryn/claude-usage), which does the same for one machine in Python. ai-usage adds the multi-machine part and the ai-space integration.

## What it shows

- **Range**: 5 hours (a subscription's rolling window), today, 7, 30, 90 days, all time; in the viewer's time zone.
- **Filters**: models (colours follow the model, not its rank, so a filter never repaints the survivors) and machines.
- **Tiles**: tokens (with the subagents' share), estimated cost, sessions, turns, per-day average.
- **Charts**: daily usage stacked by model, hourly distribution (average per active day), by model, by machine, top projects, subagents by type. Every mark has a tooltip.
- **Tables**: cost by model with the four token kinds, sessions (project, topic, model, last active, duration, turns, tokens, cost), subagent dispatches, cost by project, cost by project and branch. Sortable, collapsible, the long ones fold.
- **Widget**: an ai-space panel card with today, the last seven days and the top model.
- English and Chinese (`?lang=`), light and dark (`?theme=`, else the OS setting).

## Multi-machine

Each machine runs its own ai-usage over its own transcripts and exports its rows at `GET /api/export?since=<ms>`. A hub pulls them and labels each row with the machine's name, so every view is computed once, over one store, with a machine filter. Two ways to reach a peer:

- **Through ai-space.** When the service runs inside a space that merges peer machines, it finds the ai-usage of every peer in the space's app list and pulls through the space's own peer channel (`/api/peers/<peer>/apps/ai-usage/proxy/api/export`): token, tunnel and access layer are the space's, nothing to configure here.
- **By URL.** `USAGE_PEERS=box2=http://127.0.0.1:18880,...` names ai-usage instances reachable directly (an SSH tunnel, a LAN), for a standalone setup.

Pulls happen after every scan (every five minutes by default) and on the Refresh button; they resume from the newest row already held for that machine, minus a two-day overlap, and rows are upserted, so a peer that was down catches up on its own.

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

Environment (`.env.example` lists everything): `PORT`, `DATABASE_URL` or `SPACE_APP_DATA_DIR` for the cache, `USAGE_SOURCES` for other transcript directories, `USAGE_SCAN_INTERVAL`, `USAGE_MACHINE` (else `SPACE_NAME`, else the hostname), `USAGE_PEERS`, `SPACE_API_URL` (set by ai-space).

## Inside ai-space

`space.yaml` declares the service (port 8880, `/healthz`), the widget and a SQLite database. ai-space installs it as a default app on `init`: clone into `~/.ai-space/apps/ai-usage`, then `deploy/install.sh` (dependencies, a user-level systemd unit, start). On a machine with a hostname, set `SPACE_APP_URL_AI_USAGE=https://usage.<domain>/?lang={lang}` in the workspace `.env` so the panel tile opens the public address; the manifest itself names loopback, which is right on a laptop. Git-push deploys work like any other app with `deploy/post-receive`.

## API

| Route | |
| --- | --- |
| `GET /api/summary?range=7d&models=a,b&machines=x,y&tz=Asia/Tokyo` | everything the page shows |
| `GET /api/status` | machine, sources, counts, last scan, peers |
| `POST /api/refresh` | scan now and pull the peers |
| `GET /api/export?since=<ms>` | this machine's own rows, for a hub |
| `GET /api/widget` | the panel card |
| `GET /healthz` | 200 |

Reads trust loopback; there is no token. Exposure is the space's job (a tunnel with a login in front).

## Not captured

Sessions that run server-side and write no local transcript (Claude's cloud sessions), and calls made through the Anthropic API directly. Calls an app makes through ai-space's model service on this machine do write transcripts (they run the CLI) and are counted; the space's own model ledger stays the place to see them by app and purpose.

## License

MIT.
