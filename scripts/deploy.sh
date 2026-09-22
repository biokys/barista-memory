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
SERVER_HOST="${GAGGIMATE_SERVER_HOST:?set GAGGIMATE_SERVER_HOST in .env}"
SERVER_DIR="${GAGGIMATE_SERVER_DIR:?set GAGGIMATE_SERVER_DIR in .env}"
SERVICES="${GAGGIMATE_SERVICES:-barista-memory barista-memory-web}"

cd "$HERE"
if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is not clean; commit or stash first" >&2; exit 1
fi
if [ "$(git rev-parse HEAD)" != "$(git rev-parse '@{upstream}')" ]; then
  echo "HEAD is not pushed; run git push first" >&2; exit 1
fi
want="$(git rev-parse --short HEAD)"

# Services go last and unquoted on purpose: bash -s splits them into $3.., and
# the commit must stay a single positional argument before them.
ssh -o BatchMode=yes "$SERVER_HOST" bash -s "$SERVER_DIR" "$want" $SERVICES <<'REMOTE'
set -euo pipefail
dir="$1"; want="$2"; shift 2; services="$*"
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
for service in $services; do
  systemctl cat "$service" >/dev/null 2>&1 || { echo "  ($service not installed here, skipped)"; continue; }
  sudo systemctl restart "$service"
done
sleep 4
for service in $services; do
  systemctl cat "$service" >/dev/null 2>&1 || continue
  systemctl is-active --quiet "$service" && echo "deployed $have, $service active" || { journalctl -u "$service" -n 20 --no-pager; exit 1; }
done
REMOTE
