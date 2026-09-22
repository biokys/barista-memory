#!/usr/bin/env bash
#
# Deploy what is on GitHub to the Pi and restart the daemon.
#
# The Pi runs a git checkout, so "what is deployed" is always a commit you can
# name, and a stray edit made on the Pi shows up as a dirty tree instead of a
# silent divergence. Local, unpushed work is refused on purpose: the Pi pulls
# from origin, and deploying something origin has never seen would leave the
# two out of step.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$HERE/.env" ] && { set -a; . "$HERE/.env"; set +a; }
PI_HOST="${GAGGIMATE_PI_HOST:?set GAGGIMATE_PI_HOST in .env}"
PI_DIR="${GAGGIMATE_PI_DIR:?set GAGGIMATE_PI_DIR in .env}"
SERVICE="${GAGGIMATE_SERVICE:-barista-memory}"

cd "$HERE"
if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is not clean; commit or stash first" >&2; exit 1
fi
if [ "$(git rev-parse HEAD)" != "$(git rev-parse '@{upstream}')" ]; then
  echo "HEAD is not pushed; run git push first" >&2; exit 1
fi
want="$(git rev-parse --short HEAD)"

ssh -o BatchMode=yes "$PI_HOST" bash -s "$PI_DIR" "$SERVICE" "$want" <<'REMOTE'
set -euo pipefail
dir="$1"; service="$2"; want="$3"
cd "$dir"
if [ -n "$(git status --porcelain)" ]; then
  echo "Pi checkout has local changes — refusing to pull over them:" >&2
  git status --short >&2; exit 1
fi
git fetch -q origin
git checkout -q main
git reset -q --hard origin/main
have="$(git rev-parse --short HEAD)"
[ "$have" = "$want" ] || { echo "origin/main is $have, expected $want — push not visible yet?" >&2; exit 1; }
npm ci --silent
npm run build >/dev/null
sudo systemctl restart "$service"
sleep 4
systemctl is-active --quiet "$service" && echo "deployed $have, $service active" || { journalctl -u "$service" -n 20 --no-pager; exit 1; }
REMOTE
