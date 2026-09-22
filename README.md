# barista-memory

Remembers what the barista cannot: every shot, the beans and grind in force,
and how warm the machine really was — for a GaggiMate espresso machine.

Copyright © 2026 Jan Müller. Licensed under the **GNU AGPL-3.0**: use it,
change it, run it — and if you ship a changed version, even as a service,
publish your changes under the same terms. See `LICENSE`.

## Why this exists

The machine keeps at most 100 shots (`MAX_HISTORY_ENTRIES` in
`ShotHistoryPlugin.h`) in internal flash, and without an SD card that flash does
not survive a firmware update. On this machine the shot id counter had reached
409 while only 7 shots remained — roughly four hundred shots had already been
lost. The archive lives on a Raspberry Pi instead, so the record outlives both
the rotation and the upgrade.

It also removes the per-shot data entry. Beans, grind setting and dose change
once every many shots, so they are stored as periods rather than as fields on
each shot: record a change once, and every shot pulled afterwards inherits it.

## How the context works

`setups` rows are intervals, each opening at `valid_from`. A shot resolves to
the latest setup that had started by the time it began:

```
setup #1  bean=Kinini grind=3.2 dose=18   valid_from ──┐
                                                       │  shot 405  →  3.2
                                                       │  shot 406  →  3.2
setup #2  grind=3.0 (rest inherited)      valid_from ──┤
                                                       │  shot 407  →  3.0
                                                       │  shot 408  →  3.0
```

Three consequences worth the design:

- **Changing beans does not rewrite history.** Yesterday's shots keep the
  context they were actually pulled under.
- **A correction is one row.** Realising the grind changed before shot 406, not
  after, is an `UPDATE` of one `valid_from`; every affected shot re-derives.
  See `move_setup`.
- **Only what changed is recorded.** Fields left out of a change inherit from
  the previous period, so adjusting the grind does not mean retyping the bean.

A one-off pull that deviated goes in `shot_overrides`, which wins over the
setup for the fields it names. The `shot_context` view joins it all together.

## Layout

```
src/
  config.ts              environment-driven configuration
  db/schema.sql          tables, the shot_context view, and why each exists
  machineState.ts        sampling the machine's own state; power sessions,
                         operating conditions
  db/db.ts               open, migrate, setup lookup
  device/client.ts       HTTP + WebSocket access to the machine
  device/parsers/        .slog and index.bin parsers (vendored, see below)
  setups.ts              interval logic: record, inherit, correct
  notesSync.ts           push context into the machine's own shot notes
  ingest.ts              one archive pass
  daemon.ts              poll loop (systemd)
  mcp/server.ts          MCP tools: the archive, the machine's live state, and
                         the two things that write to the machine (profiles,
                         settings read)
  mcp/profileSchema.ts   phase schema for save_profile, mirrors the firmware
  device/machineSettings.ts  allowlist for /api/settings (it leaks passwords)
  cli.ts                 same operations without an MCP client
scripts/archive.sh       wrapper used by the Robion panel and by hand
deploy/                  systemd unit and deployment notes
```

`device/parsers/`, `device/shotTransformer.ts`, `device/machineSettings.ts`
and `mcp/profileSchema.ts` began life in
[gaggimate-mcp](https://github.com/biokys/gaggimate-mcp), whose remaining
tools (profiles, settings) were folded into this server on 2026-09-22 so one
MCP covers both reading the archive and changing the machine. The parsers
mirror the firmware's `shot_log_format.h` — keep them in sync with the device.

`save_profile` merges the caller's fields onto the existing profile before
sending, because the machine replaces the whole profile: editing one phase's
transition must not reset the description or the selected flag.

## Two decisions that matter

**Raw `.slog` is stored as a BLOB, not just parsed columns.** This is not
caution for its own sake: the parser vendored here was, at one point, a version
behind the firmware's `.slog` v7 layout and decoded the tail of every shot as
garbage. Because the archive held the original bytes, fixing the parser fixed
every shot already stored — no re-ingest, no data loss. Parsed values are a
cache; the blob is the record.

**Ingest works by set difference, not a high-water mark.** The missing ids are
whatever the device lists and the archive lacks. A gap left by the Pi being down
is filled on the next pass, and a device whose ids restarted after a firmware
update does not silently stop being archived.

## Knowing when the machine was on

The firmware exposes no uptime, no boot time and no heat-up log: `/api/settings`
is configuration, `/api/status` is a live reading, and `evt:status` over the
WebSocket is live too. So the only record that the machine was ever switched on
is one kept from outside.

The daemon samples `/api/status` on every pass into `machine_state`. Two things
make that enough:

- **No answer is the observation.** The machine replies only while it has power,
  so an unreachable poll is how a power-off enters the record — not an error to
  be swallowed. The sample is taken before the ingest and outside its error
  handling for exactly that reason.
- **It heats itself.** After power-on the boiler drives to setpoint without
  being asked, so the temperature curve is a power-on detector, not merely a
  thermometer.

Rows are written on change rather than per poll — dense while the temperature
climbs, sparse while it sits at setpoint — with a heartbeat so a long steady
stretch does not read as a gap. `powerSessions()` reconstructs sessions from
that; its gap threshold is derived from the heartbeat interval, because a
threshold chosen below it turns one quiet session into one session per
heartbeat.

`get_archived_shot` reports how long the machine had been up when a shot was
pulled and whether the boiler had settled. That matters as much as the profile:
a boiler still climbing overshoots, and the curve then shows a shot the profile
never asked for.

## Writing back to the machine

After archiving, the derived context is pushed into the machine's own shot notes
(`req:history:notes:save`), so bean, dose and ratio appear on the machine's Shot
History screen without anyone typing them there.

Two firmware behaviours constrain this, both handled in `notesSync.ts`:

- The save replaces the whole notes object and copies `rating` into the index
  unconditionally, so a partial write clears an existing rating. Existing notes
  are read and merged rather than composed fresh.
- `doseOut` is copied into the index as the shot's volume. That volume is a
  measurement, so it is never sent — only context the machine could not know.

This is convenience, not backup: those notes live in the same flash that an
update clears. The archive is the durable copy.

## Usage

```bash
npm install && npm run build

# what am I pulling right now
npm run cli -- show

# changed the grind, nothing else
npm run cli -- set-setup --grind 3.0

# new beans
npm run cli -- set-setup --bean "Rwanda Kinini" --roaster Doubleshot --grind 3.4

npm run cli -- ingest      # one pass
npm run daemon             # poll forever (what systemd runs)
```

Deployment and MCP registration: see `deploy/README.md`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GAGGIMATE_HOST` | `gaggimate.local` | Machine address. Prefer an IP — mDNS can take seconds. |
| `GAGGIMATE_PROTOCOL` | `ws` | `ws` or `wss`; the HTTP scheme follows. |
| `GAGGIMATE_DB` | `./gaggimate-archive.db` | SQLite file. Put it on storage that outlives the machine. |
| `GAGGIMATE_POLL_INTERVAL` | `30` | Seconds between passes in daemon mode. |
| `GAGGIMATE_TIMEOUT_MS` | `10000` | Per-request timeout against the machine. |
| `GAGGIMATE_SYNC_NOTES` | `1` | `0` leaves the machine's notes untouched. |
