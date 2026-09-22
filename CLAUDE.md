# CLAUDE.md

Guidance for Claude Code working in this repository (barista-memory).

## What this is

A durable shot archive and brewing context for a GaggiMate espresso machine
(Gaggia Classic Pro E24, DF64 grinder). It exists to keep every shot in a
database the user owns, with context the machine cannot know. (The original
motivation was a 100-shot limit in the firmware of the time — the id counter
was at 409 with 7 left; the GaggiMate community says current firmware has no
such limit, so do not repeat that claim in public material.)

It runs on a Raspberry Pi, not on the machine. Read `README.md` for the design;
this file is about what bites you while changing it.

## Hardware and hosts

Addresses, user names and the deploy target are **not in this file** — they
live in `CLAUDE.local.md` (gitignored) next to it, and in `.env` for
`scripts/archive.sh`. Read `CLAUDE.local.md` first when it exists; if it does
not, ask, do not guess. In short: the espresso machine is on the LAN, the
daemon runs on a Raspberry Pi under its own user, the database is the Pi's
`data/archive.db`.

Prefer the IP over `gaggimate.local`: mDNS resolution takes ~5 s on macOS and
2.6 ms on the Pi, and the client's request timeout is 10 s.

Node's `fetch` on the developer Mac gets `EHOSTUNREACH` to the machine while
`curl` from the same shell succeeds. Test against the machine **on the Pi**, not
locally (the Pi and the machine are reached via `.env`, see `.env.example`). Logic that needs no device (schema, setups, sessions) tests fine
locally against a scratch SQLite file.

## Firmware behaviours that have already caused bugs

These are not hypotheticals. Each one was found by reading
`~/Projects/gaggimate-mcp/gaggimate` (a checkout of the firmware, reference
only) after something went wrong.

**`req:history:notes:save` replaces the whole notes object and resets the
rating.** `ShotHistoryPlugin.cpp` reads `notes["rating"]` unconditionally, so a
save that omits it stores 0. Always read the existing notes and merge —
`notesSync.ts` is the only intended entry point.

**`doseOut` in notes overwrites the shot's recorded volume.** The same handler
copies it into the index as `entry.volume`. That volume is a measurement, so
this code never sends `doseOut`. (`updateIndexMetadata` does honour `volume > 0`
as "leave it alone", which is why omitting the field is safe.)

**`POST /api/settings` applies booleans through `hasArg()`.** A partial write
silently clears every boolean setting not present in the body. Any write tool
needs a full read-modify-write; this is why `get_machine_settings` is
read-only.

**`req:profiles:save` replaces the whole profile.** Fields not sent are gone,
`selected` included — an edit through the old machine MCP came back with
`selected: false`. `save_profile` here loads the existing profile and merges
the caller's fields onto it first. Verified by a no-change round trip of
"Light 94" that came back identical.

**`GET /api/settings` returns `wifiPassword`, `apPassword` and `haPassword` in
cleartext, unauthenticated.** Never pass that payload through unfiltered.

**Only `/api/settings`, `/api/status`, `/api/scales/*`, `/api/history/*` and
`/api/core-dump` are real.** Every other path returns a gzipped `index.html`
with HTTP 200, so "it returned 200" proves nothing.

**The machine records no uptime, boot time or heat-up.** `/api/settings` is
configuration and `/api/status` is a live reading. `machine_state` sampling
exists because there is no other way to know when it was switched on.

## The vendored parsers

`src/device/parsers/` and `src/device/shotTransformer.ts` are copied from
`github.com/biokys/gaggimate-mcp`, which in turn mirrors the firmware's
`shot_log_format.h`.

They were once a version behind the firmware: `.slog` v7 widened the tick field
from uint16 to uint32, and the old layout shifted every field after it and
shortened the record stride, so the tail of every shot decoded as garbage — an
unwritten `0xFFFF` reads as 6553.5 bar or 6553.4 °C. **If temperatures or
pressures come back physically impossible, suspect the parser before the
machine.** Sane ranges: 20–105 °C, 0–12 bar.

When updating them, keep them in sync with the device, not with the upstream
repo. The old machine MCP (`gaggimate-mcp`) is retired as of 2026-09-22: its
profile and settings tools live here, the receipt pipeline and Claude Code use
this server only.

## Invariants worth preserving

**Raw `.slog` is stored as a BLOB, not only parsed columns.** This already paid
for itself: fixing the v7 parser fixed every shot already archived, with no
re-ingest. Parsed values are a cache; the blob is the record.

**Ingest works by set difference against the archive, never a high-water mark.**
A gap left by the Pi being down is filled on the next pass, and a device whose
ids restarted after a firmware update does not silently stop being archived.

**Brewing context lives in `setups` as time intervals, not as fields on shots.**
A change is recorded once and later shots inherit it; unspecified fields inherit
from the previous period. Correcting *when* a change happened is one `UPDATE` of
`valid_from`, and every affected shot re-derives through the `shot_context`
view. Never denormalise the bean onto the shot row — that breaks the correction
path.

**`recordSetup` opens no period when nothing changed.** The controls panel sends
the slider's value on every press, so without this the history fills with
identical periods that a later correction would have to be applied to one by one.

**`machine_state` rows are written on change, not per poll**, with a heartbeat so
a steady stretch does not read as a gap. `powerSessions()` derives its gap
threshold from `HEARTBEAT_S`; an independently chosen value below it chopped one
quiet session into one session per heartbeat.

**Heat-up is measured from the standby→heating transition, not from power-on.**
The machine can sit powered in standby for an hour; timing from the session
start reported that hour as the heat-up (100 minutes instead of 93 seconds).

**A shot is matched to the heating episode that preceded it, not the session's
latest.** `powerSessions()` keeps every standby→heating transition as
`heating_episodes`; `machineContextForShot()` picks the last one at or before
the shot. Using the latest was right at ingest (the shot had just happened) but
`recompute-context --all` would have rewritten a morning shot with the
afternoon wake-up. The per-shot result is stored on `shots` as
`machine_powered_for_s`, `machine_heating_for_s`, `machine_heatup_s` and
`machine_settled` so it can be correlated in plain SQL; NULL means the state
record started after the shot, never "cold".

**The firmware never records a run on a utility profile.**
`ShotHistoryPlugin::startRecording()` returns early when `isUtility()`, so a
backflush on the flagged `Backflush` profile leaves no index entry and no
`.slog`; the first backflush after the maintenance feature shipped (2026-09-22)
was invisible to ingest. Backflushes are therefore watched live:
`statusStream.ts` keeps one WebSocket open (the machine's own UI does the same)
and `flushWatch.ts` logs a backflush when the selected profile is utility and
a process is active for ≥ 20 s. The `evt:status` shape differs between
firmware versions (the device omits `pr`, `fl` and `process` when idle, and
the checkout is older than the device), so the watcher traces one status line
per 5 s to the journal while a utility profile is selected in brew mode —
look there first when a flush was not logged. The index path still exists:
a run on a profile that was *not* flagged utility at the time (shot 406, made
before the flag was set) is classified `kind = 'flush'` by profile id, and the
`shot_context` view filters on `kind = 'shot'` so every statistic, the history
and notes sync see coffees only. Maintenance status is computed from the log
and the archive on every read — nothing about "due" is stored, so a changed
interval or a backdated entry applies at once.

**Notes sync compares a fingerprint before touching the machine.** `notes_sync`
stores the archive-side inputs each push was built from; a pass where they are
unchanged opens no WebSocket. Before that, every pass cost one connection per
shot on the device, forever, to discover nothing had changed.

**`machine_settledness` is the readiness figure; `machine_settled` is not.**
`thermalModel.ts` tracks the slow thermal mass (group, brass) the sensor cannot
see, as a fraction of the way from room to setpoint. A first-order model with
two time constants: TAU_COOL = 58 min, *fitted* to the 2026-09-20 standby
curve; TAU_HEAT = 20 min, the one free parameter (`GAGGIMATE_TAU_HEAT_MIN`),
to be tuned with `cli calibrate` against bloom-phase temperature. "Heating" is
decided by what the boiler reads, not by the target: on 2026-09-21 17:00 the
machine sat in brew mode with target 94 while the sensor fell 90 → 49 °C over
an hour. Test scenarios that must keep holding: woken from 20 °C +2 min ≈ 7 %,
from 60 °C +2 min ≈ 57 %, an hour of standby after a warm session ≈ 50 %.

**Web URLs are relative, never `/api/...`.** The container image doubles as a
Home Assistant add-on served through ingress at
`/api/hassio_ingress/<token>/`; the hash router never changes the document
path, so `api/now` resolves correctly there and at the root. An absolute path
breaks the add-on silently (the page loads, every request 404s). Verified
with a prefix-stripping proxy on 2026-09-22. `src/main.ts` is the container's
entry point (daemon + web in one process, HA `options.json` mapped onto the
`GAGGIMATE_*` variables); the systemd deployment still runs the two services
separately and is unaffected.

**The web UI and the MCP share every code path.** `src/web/server.ts` is a
thin JSON translation of `shots.ts`, `profiles.ts`, `stats.ts`, `events.ts`,
`setups.ts` and `machineState.ts`; the MCP calls the same functions. Put
logic in those modules, never in a route or a tool handler, or the two will
drift. `web/` has no build step and no framework on purpose — it is served
straight from the checkout, with uPlot and Inter coming from `node_modules`.
Dictionaries in `web/i18n/` must stay key-for-key identical (a one-line
python check in the git log shows how).

## Two measurement caveats to keep repeating

The **boiler sensor reaches target long before the machine does** — observed
41 → 90 °C in 31 seconds, from 25 °C and from 41 °C alike, so `heatup_s`
measures the sensor, not the machine. A shot pulled 93 s after switch-on is not
the same as one pulled an hour later; `machine_settledness` is what tells them
apart. `machine_now` says this in its `note` field; keep it there.

The **Bluetooth scale corrupts the last sample of a shot** often enough to
matter: four of the first nine archived shots ended with a spurious 0, a 58 g
spike, or nothing. The firmware writes that value into the index as the shot
volume, so `final_weight_g` and any ratio derived from it can be wrong. That is
why `stableWeight.ts` exists: it skips the self-tare, rejects increases faster
than coffee can arrive and drops below what has accumulated, then believes the
machine unless the curve says it cannot be right. `ratio` in `shot_context`
follows `stable_weight_g`; `final_weight_g` is kept untouched beside it. A
median of the last samples was tried first and made the still-flowing shots
worse — do not reintroduce it.

## Commands

```bash
npm run build            # tsc, and copies schema.sql into dist/
npm run cli -- show      # what context is in force
npm run cli -- ingest    # one archive pass
npm run cli -- recompute-weights [--all]   # re-derive stable weights from stored logs
npm run cli -- recompute-context [--all]   # re-derive machine warm-up context
npm run cli -- maintenance               # where each cleaning routine stands
npm run cli -- maintenance-done cafiza   # log a routine (backflush|cafiza|descale|water_filter|gasket)
npm run cli -- calibrate                   # bloom temperature vs. settledness, to tune TAU_HEAT
./scripts/archive.sh show|stats|ingest|set-setup|fix-setup|recompute|recompute-context   # same, against the Pi
```

Container image: `docker build -t barista-memory .`; the GHCR images are built
by `.github/workflows/docker.yml` on a `v*` tag (multi-arch plus the per-arch
names the HA add-on's `{arch}` needs). The add-on lives in `hassio/` with
`repository.yaml` at the root, so this repo is also the add-on repository;
bump `hassio/barista-memory/config.yaml`'s `version` with each tag.

Deploy to the server: **commit, push, `npm run deploy`** (`scripts/deploy.sh`,
host and path from `.env`). The server is a git checkout of `origin/main`; the
script refuses an unclean or unpushed tree here and refuses to pull over local
edits there. Do not tar files over — that is how the old vendored copies drifted.

The MCP tools live in `src/mcp/tools.ts` and are served two ways: stdio
(`src/mcp/server.ts`, what Claude Code on this Mac uses over ssh) and
Streamable HTTP at `/mcp` on the web port, stateless, one server per request,
only when `GAGGIMATE_MCP_TOKEN` is set (`src/mcp/http.ts`). The HTTP one is
for container and add-on users; it is not reachable through HA ingress.

## Conventions

- SQLite through Node 22's built-in `node:sqlite` (still flagged experimental,
  hence `--no-warnings`). No native dependencies on purpose — this has to build
  on an ARM Pi.
- Schema changes that `CREATE ... IF NOT EXISTS` cannot make go in `migrate()`
  in `src/db/db.ts`, behind `SCHEMA_VERSION`. Each step must also be safe on a
  fresh database, which starts at `user_version` 0 too.
- Comments explain *why*, especially where a firmware behaviour or a past bug
  forced the shape of the code. Do not narrate what the line already says.
- All identifiers, comments and commit messages in English; the user is Czech
  and conversation is in Czech, but the repository is not.

## Related

- `~/Projects/gaggimate-mcp/mcp-server` — the former machine MCP, retired;
  everything it did is in `src/mcp/server.ts` now. Kept for history.
- `~/Projects/gaggimate-mcp/gaggimate` — firmware checkout, reference only.
  Read it before assuming how the device behaves.
- `~/c19-printer` on the Pi — the receipt printer pipeline that watches for new
  shots. **Not in git; back it up before editing** (`autoprint.bak-*`,
  `print.py.bak-*` exist from 2026-09-21). Since that date the receipt is built
  from this archive's MCP (`autoprint/shot_facts.py` → `get_archived_shot`),
  so a change to `shot_context` or `get_archived_shot`'s shape can break the
  print — dry-run one with
  `autoprint/print_shot_receipt.py <id> --dry-run --preview /tmp/r.png` after
  touching either. `brain.sh` calls no tools any more; it turns the facts on
  stdin into a one-line verdict. Receipts failed before that when the printer
  was off; that is the expected failure, not a bug.
