#!/usr/bin/env bash
# Install (or refresh) ai-usage on this machine: dependencies, a user-level
# service, start, health check. Run from the checkout: bash deploy/install.sh
# ai-space runs it after cloning a default app on `init`; it is idempotent.
#
#   Linux with user systemd   ~/.config/systemd/user/ai-usage.service (deploy/app.service)
#   macOS                     ~/Library/LaunchAgents/ai-usage.plist (deploy/app.plist); the
#                             service reads the checkout's .env itself (Bun loads it), so a
#                             laptop outside a space puts BLOB_URL, S3_* and USAGE_MACHINE there
#   neither                   prints how to start by hand
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP=ai-usage
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="$(command -v bun || true)"
[ -n "$BUN" ] || { echo "bun not found (curl -fsSL https://bun.sh/install | bash)"; exit 1; }
PORT_="${PORT:-8880}"

cd "$HERE"
"$BUN" install --production --frozen-lockfile 2>&1 | tail -1
mkdir -p data

wait_healthy() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if curl -fsS "http://127.0.0.1:$PORT_/healthz" >/dev/null 2>&1; then
      echo "$APP is up on 127.0.0.1:$PORT_"
      return 0
    fi
  done
  return 1
}

if [ "$(uname -s)" = "Darwin" ]; then
  mkdir -p ~/Library/LaunchAgents
  PLIST=~/Library/LaunchAgents/$APP.plist
  sed "s|@DIR@|$HERE|g; s|@BUN@|$BUN|g" deploy/app.plist > "$PLIST"
  # Unload the old copy and wait for launchd to let go of it before loading the new plist.
  launchctl bootout "gui/$(id -u)/$APP" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "gui/$(id -u)/$APP" >/dev/null 2>&1 || break
    sleep 0.5
  done
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  wait_healthy && exit 0
  echo "$APP is not answering on 127.0.0.1:$PORT_; see: tail -50 $HERE/data/ai-usage.log" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "no user systemd here; start by hand: cd $HERE && PORT=$PORT_ $BUN src/index.ts"
  exit 0
fi

mkdir -p ~/.config/systemd/user
sed "s|@DIR@|$HERE|g; s|%h/.bun/bin/bun|$BUN|" deploy/app.service > ~/.config/systemd/user/$APP.service
systemctl --user daemon-reload
systemctl --user enable --now $APP
systemctl --user restart $APP
wait_healthy && exit 0
systemctl --user --no-pager --lines=10 status $APP || true
echo "$APP is not answering on 127.0.0.1:$PORT_; see: journalctl --user -u $APP -n 50" >&2
exit 1
