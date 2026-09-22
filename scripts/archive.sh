#!/usr/bin/env bash
#
# Thin wrapper around the archive CLI running on the Pi.
#
# The Robion panel and any shell here call this rather than composing an ssh
# command themselves: nesting quotes through ssh is where these break.
set -euo pipefail

# Addresses come from .env next to this repo (see .env.example), never from here.
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }
SERVER_HOST="${GAGGIMATE_SERVER_HOST:?set GAGGIMATE_SERVER_HOST in .env}"
SERVER_DIR="${GAGGIMATE_SERVER_DIR:?set GAGGIMATE_SERVER_DIR in .env}"
DEVICE="${GAGGIMATE_HOST:?set GAGGIMATE_HOST in .env}"

remote() {
  # Each argument is passed through as a single quoted word, so bean names with
  # spaces survive the trip.
  local quoted=""
  for arg in "$@"; do
    quoted+=" $(printf '%q' "$arg")"
  done
  ssh -o BatchMode=yes "$SERVER_HOST" \
    "cd $SERVER_DIR && GAGGIMATE_HOST=$DEVICE GAGGIMATE_DB=$SERVER_DIR/data/archive.db node --no-warnings dist/cli.js$quoted"
}

case "${1:-}" in
  set-setup|fix-setup)
    cmd="$1"; shift
    # Empty values mean "unchanged": the panel always sends every field, but a
    # blank one must not clear what is already recorded.
    args=()
    while [ $# -gt 0 ]; do
      flag="$1"; shift
      # A panel may render a blank field as an empty word or drop it entirely,
      # so anything that looks like the next flag is treated as no value.
      value=""
      if [ $# -gt 0 ] && [[ "$1" != --* ]]; then
        value="$1"; shift
      fi
      [ -n "$value" ] && args+=("$flag" "$value")
    done
    [ ${#args[@]} -eq 0 ] && { echo "nothing to change"; exit 0; }
    remote "$cmd" "${args[@]}"
    ;;
  show)   remote show ;;
  status) remote status ;;
  last)   remote last ;;
  calibrate) remote calibrate ;;
  recompute) remote recompute-weights "${2:-}" ;;
  recompute-context) remote recompute-context "${2:-}" ;;
  stats)  remote stats ;;
  ingest) remote ingest ;;
  *)
    echo "usage: archive.sh {set-setup ... | fix-setup --id N ... | show | status | last | stats | ingest | recompute [--all] | recompute-context [--all]}" >&2
    exit 2
    ;;
esac
