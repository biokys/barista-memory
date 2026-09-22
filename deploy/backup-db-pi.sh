#!/usr/bin/env bash
#
# Runs ON the Pi: snapshot the archive database and ship it to the backup
# host. The Pi holds the only live copy of every shot, so this must not depend
# on any other machine being awake — hence it runs here, not on the laptop.
#
# The database is in WAL mode, so a plain copy can catch it mid-write;
# sqlite3's .backup takes a transactional snapshot first. Keeps the last
# BACKUP_KEEP daily copies on the remote.
set -euo pipefail

DB="${GAGGIMATE_DB:-$HOME/gaggimate-archive/data/archive.db}"
# A *relative* remote path, resolved by the remote's shell against its own
# home. Never write "~" here: the local shell expands it to THIS user's home
# before the value ever reaches the other machine.
DEST="${BACKUP_DEST:?set BACKUP_DEST, e.g. user@host:backups/barista-memory}"
KEEP="${BACKUP_KEEP:-30}"

host="${DEST%%:*}"
dir="${DEST#*:}"
stamp="$(date +%F)"
tmp="$(mktemp /tmp/archive-backup.XXXXXX)"
trap 'rm -f "$tmp" "$tmp.gz"' EXIT

sqlite3 "$DB" ".backup '$tmp'"
# Verify before shipping: a backup that does not open is worse than none,
# because it looks like one.
shots="$(sqlite3 "$tmp" 'SELECT COUNT(*) FROM shots')"
gzip -f "$tmp"

ssh -o BatchMode=yes "$host" "mkdir -p '$dir'"
scp -q "$tmp.gz" "$host:$dir/archive-$stamp.db.gz"
ssh -o BatchMode=yes "$host" "cd '$dir' && ls -1t archive-*.db.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f"
echo "$(date '+%F %T') $DEST/archive-$stamp.db.gz ($shots shots)"
