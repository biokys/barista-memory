# Deploying the archive to the Raspberry Pi

The archive runs where the data must outlive the machine — on the Pi, not on the
GaggiMate, whose flash is cleared by a firmware update.

The Pi runs a **git checkout**, so what is deployed is always a commit you can
name, and a stray edit made on the Pi shows up as a dirty tree rather than a
silent divergence.

```bash
# once, on the Pi (it needs read access to the repo — a deploy key is enough)
git clone git@github.com:biokys/barista-memory.git ~/barista-memory
cd ~/barista-memory && npm ci && npm run build

# fill in <user> and <machine-ip>, then
sudo cp deploy/barista-memory.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now barista-memory
journalctl -u barista-memory -f
```

## Every deploy after that

From the laptop, with `.env` filled in: `npm run deploy`. It refuses an
unclean or unpushed tree, pulls `origin/main` on the Pi, refuses to pull over
local edits there, builds, restarts the service and confirms it is active.

## Using the MCP server from Claude Code

The MCP speaks stdio, so it needs no port of its own — it is reached over ssh:

```bash
claude mcp add barista-memory -- \
  ssh <user>@<pi> "cd ~/barista-memory && GAGGIMATE_HOST=<machine-ip> GAGGIMATE_DB=$HOME/barista-memory/data/archive.db node --no-warnings dist/mcp/server.js"
```

## Backing it up

The Pi holds the only live copy of every shot. `deploy/backup-db-pi.sh` runs
**on the Pi** — not on a laptop that may be asleep — takes a transactional
snapshot with `sqlite3 .backup` (the database is in WAL mode, so a plain copy
can catch it mid-write), verifies the snapshot opens, and ships it gzipped to
a backup host over ssh, keeping the last 30. Install:

```bash
sudo apt-get install -y sqlite3
cp deploy/backup-db-pi.sh ~/barista-memory/backup-db.sh && chmod +x ~/barista-memory/backup-db.sh
# a key for the backup host, then in the Pi's crontab:
17 4 * * * BACKUP_DEST=<user@backup-host>:backups/barista-memory ~/barista-memory/backup-db.sh >> ~/barista-memory/data/backup.log 2>&1
```
