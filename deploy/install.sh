#!/usr/bin/env bash
# Install (or refresh) ai-usage on this machine: dependencies, the user-level
# systemd unit, start, health check. Run from the checkout: bash deploy/install.sh
# ai-space runs it after cloning a default app on `init`; it is idempotent.
# Without systemd (a laptop) it installs dependencies and prints how to start.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP=ai-usage
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="$(command -v bun || true)"
[ -n "$BUN" ] || { echo "bun not found (curl -fsSL https://bun.sh/install | bash)"; exit 1; }
PORT_="${PORT:-8880}"

cd "$HERE"
"$BUN" install --production --frozen-lockfile 2>&1 | tail -1

if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "no user systemd here; start by hand: cd $HERE && PORT=$PORT_ $BUN src/index.ts"
  exit 0
fi

mkdir -p ~/.config/systemd/user
sed "s|@DIR@|$HERE|g; s|%h/.bun/bin/bun|$BUN|" deploy/app.service > ~/.config/systemd/user/$APP.service
systemctl --user daemon-reload
systemctl --user enable --now $APP
systemctl --user restart $APP
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -fsS "http://127.0.0.1:$PORT_/healthz" >/dev/null 2>&1; then
    echo "$APP is up on 127.0.0.1:$PORT_"
    exit 0
  fi
done
systemctl --user --no-pager --lines=10 status $APP || true
echo "$APP is not answering on 127.0.0.1:$PORT_; see: journalctl --user -u $APP -n 50" >&2
exit 1
