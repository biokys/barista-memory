# Deploying the archive to the Raspberry Pi

The archive runs where the data must outlive the machine — on the Pi, not on the
GaggiMate, whose flash is cleared by a firmware update.

```bash
# from the project root
tar czf - --exclude node_modules --exclude .git src package.json tsconfig.json \
  | ssh <user>@<pi> "mkdir -p ~/barista-memory && tar xzf - -C ~/barista-memory"
ssh <user>@<pi> "cd ~/barista-memory && npm install && npm run build"

sudo cp deploy/barista-memory.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now barista-memory
journalctl -u barista-memory -f
```

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
17 4 * * * BACKUP_DEST=<user@backup-host>:~/backups/barista-memory ~/barista-memory/backup-db.sh >> ~/barista-memory/data/backup.log 2>&1
```
