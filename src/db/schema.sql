-- Local archive of GaggiMate espresso shots and the brewing context they were
-- pulled under.
--
-- The machine keeps its history in its own flash; this database — living on a
-- different machine — is the durable record. Everything here is either copied
-- from the device before it rotates out, or is context the device never had.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- One row per shot the machine recorded.
--
-- raw_slog keeps the device's own binary sample log verbatim. Parsed columns
-- are a convenience; the blob is the source of truth, so fields this code does
-- not read today (puck resistance, target flow, system info) can still be
-- recovered from the archive later.
CREATE TABLE IF NOT EXISTS shots (
  id             INTEGER PRIMARY KEY,          -- the device's own shot id
  started_at     INTEGER NOT NULL,             -- unix seconds, from the device
  profile_id     TEXT,
  profile_name   TEXT,
  duration_ms    INTEGER,
  final_weight_g REAL,                         -- as the machine recorded it; never written back
  -- What the cup most likely held: the machine's figure unless the curve shows
  -- it cannot be right. See stableWeight.ts — the scale glitches often enough
  -- that ratios computed from final_weight_g alone are not trustworthy.
  stable_weight_g REAL,
  stable_weight_source TEXT,                   -- 'recorded' | 'curve' | 'none'
  -- The machine's thermal state when the shot started, derived from
  -- machine_state and stored here so it can be correlated with the result in
  -- plain SQL. NULL means no samples cover that time — the record started later
  -- than the shot — never "cold".
  machine_powered_for_s INTEGER,               -- seconds since it last got power
  machine_heating_for_s INTEGER,               -- seconds since it was last told to heat
  machine_heatup_s      INTEGER,               -- how long that heat-up took to reach target
  machine_settled       INTEGER,               -- 1 if the boiler had reached target before the shot
  -- The slow thermal mass (group, brass) as a fraction of the way from room to
  -- setpoint, 0–100, from thermalModel.ts. Unlike machine_settled this tells a
  -- wake-up from 60 °C apart from one from 20 °C, and a machine woken five
  -- minutes ago from one woken half an hour ago.
  machine_settledness   INTEGER,
  device_rating  INTEGER,
  incomplete     INTEGER NOT NULL DEFAULT 0,
  raw_slog       BLOB,
  ingested_at    INTEGER NOT NULL,
  -- 'shot' or 'flush'. A backflush through the machine is recorded by the
  -- firmware exactly like a coffee; it is told apart by the profile's utility
  -- flag (falling back to the profile's name when the machine is unreachable).
  -- Flushes stay archived but leave every coffee statistic.
  kind           TEXT NOT NULL DEFAULT 'shot',
  -- Water pumped during this run, in ml, from the flow trace. Scale runs on
  -- water, not on coffee, so descaling is due by litres, not by shots.
  water_ml       REAL
);

CREATE INDEX IF NOT EXISTS shots_started_at ON shots (started_at);

-- A coffee as an identity, apart from the periods it was ground in: the
-- same bag bought again next month is the same coffee, and "what grind did
-- this one end up at last time" needs that identity, not a text match.
-- The name and roaster are the identity; roaster may be unknown, hence the
-- COALESCE in the index. Targets and the usual bag weight belong here too,
-- since they are properties of the coffee, not of a grind period.
CREATE TABLE IF NOT EXISTS coffees (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  roaster           TEXT,
  origin            TEXT,
  process           TEXT,                     -- washed | natural | honey | ... free text
  roast_level       TEXT,                     -- light | medium | dark, free text
  bag_g             REAL,                     -- weight of the package it comes in
  target_time_min_s REAL,                     -- the extraction time window aimed for
  target_time_max_s REAL,
  target_ratio      REAL,
  note              TEXT,
  archived          INTEGER NOT NULL DEFAULT 0,  -- hidden from pickers, kept for history
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS coffees_identity ON coffees (name, COALESCE(roaster, ''));

-- The brewing context, stored as intervals rather than per shot.
--
-- Beans, grind setting and dose change once every many shots, so a row here
-- opens a period and every shot pulled after it inherits it. Correcting when a
-- change happened is a single UPDATE of valid_from; no shot rows are touched.
--
-- bean and roaster are kept as text beside coffee_id: they predate the
-- coffees table and let a period be read without the join. When both are
-- present the coffee wins, so renaming a coffee renames its history.
CREATE TABLE IF NOT EXISTS setups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  valid_from    INTEGER NOT NULL,              -- unix seconds; ties are broken by id
  coffee_id     INTEGER REFERENCES coffees (id),
  bean          TEXT,
  roaster       TEXT,
  roast_date    TEXT,                          -- ISO date, the machine has no such field
  grind_setting TEXT,                          -- free text: grinders are not all numeric
  dose_g        REAL,
  basket        TEXT,
  note          TEXT,
  created_at    INTEGER NOT NULL
);

-- One-off changes that are not a value but a turning point: a new WDT tool,
-- a puck screen, a different basket, a change of technique. Nothing about a
-- shot records these, yet "every shot since" is exactly what one wants to
-- compare. Like setups they partition the timeline; unlike setups they carry
-- no inheritable fields, only a name.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,                  -- unix seconds
  kind       TEXT NOT NULL,                     -- equipment | technique | maintenance | beans | other
  title      TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_at ON events (at);

-- Small key/value settings changed from the UI (printer address, auto-print).
-- Environment variables are the defaults; a row here wins.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Routines the machine needs and how often. Each is worn down by something
-- different — flushes and Cafiza by coffee (shots), descaling by water
-- (litres), a gasket by time — so a type carries whichever intervals apply and
-- its status is *computed* from the archive, never stored. Seeded by db.ts
-- with the usual Gaggia Classic figures; the intervals are yours to change,
-- since water hardness and filtering vary more than machines do.
CREATE TABLE IF NOT EXISTS maintenance_types (
  key              TEXT PRIMARY KEY,           -- backflush | cafiza | descale | water_filter | gasket
  sort             INTEGER NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  interval_shots   INTEGER,
  interval_water_l REAL,
  interval_days    INTEGER
);

-- When a routine was done. auto = detected from a utility-profile run rather
-- than entered by hand; shot_id then points at that run.
CREATE TABLE IF NOT EXISTS maintenance_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type_key   TEXT NOT NULL REFERENCES maintenance_types (key),
  at         INTEGER NOT NULL,
  note       TEXT,
  auto       INTEGER NOT NULL DEFAULT 0,
  shot_id    INTEGER REFERENCES shots (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS maintenance_log_type_at ON maintenance_log (type_key, at);

-- Deviations for a single shot, for the rare pull that did not use the setup.
CREATE TABLE IF NOT EXISTS shot_overrides (
  shot_id       INTEGER PRIMARY KEY REFERENCES shots (id) ON DELETE CASCADE,
  bean          TEXT,
  grind_setting TEXT,
  dose_g        REAL,
  note          TEXT
);

-- Subjective judgement, kept apart from anything measured.
CREATE TABLE IF NOT EXISTS tastings (
  shot_id    INTEGER PRIMARY KEY REFERENCES shots (id) ON DELETE CASCADE,
  rating     INTEGER,                          -- 0-5, matching the device's field
  note       TEXT,
  created_at INTEGER NOT NULL
);

-- What was last pushed into the device's own notes, so a sync is skipped when
-- nothing changed and can be re-driven when it did.
CREATE TABLE IF NOT EXISTS notes_sync (
  shot_id     INTEGER PRIMARY KEY REFERENCES shots (id) ON DELETE CASCADE,
  synced_at   INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  -- The archive-side inputs the payload was built from. Comparing these needs
  -- no round trip to the machine, so a pass where nothing changed costs it
  -- nothing; reading the existing notes back is done only when they differ.
  fingerprint TEXT
);

-- A shot together with the context it was pulled under.
--
-- The setup is the latest one that had started by the time the shot began, so
-- changing beans today leaves yesterday's shots reading correctly. An override
-- wins over the setup for the one field it names. Two setups recorded in the
-- same second are ordered by id, so the one recorded later wins.
CREATE VIEW IF NOT EXISTS shot_context AS
SELECT
  s.id,
  s.started_at,
  s.profile_id,
  s.profile_name,
  s.duration_ms,
  s.final_weight_g,
  s.stable_weight_g,
  s.stable_weight_source,
  s.machine_powered_for_s,
  s.machine_heating_for_s,
  s.machine_heatup_s,
  s.machine_settled,
  s.machine_settledness,
  s.water_ml,
  s.incomplete,
  COALESCE(o.bean, c.name,  su.bean)          AS bean,
  COALESCE(c.roaster,       su.roaster)       AS roaster,
  su.roast_date,
  COALESCE(o.grind_setting, su.grind_setting) AS grind_setting,
  COALESCE(o.dose_g,        su.dose_g)        AS dose_g,
  su.basket,
  -- Ratio follows the stable weight, falling back to the raw figure only
  -- before the weights have been derived.
  CASE
    WHEN COALESCE(o.dose_g, su.dose_g) > 0
     AND COALESCE(s.stable_weight_g, s.final_weight_g) > 0
    THEN ROUND(COALESCE(s.stable_weight_g, s.final_weight_g) / COALESCE(o.dose_g, su.dose_g), 2)
  END AS ratio,
  t.rating,
  t.note AS taste_note,
  su.id  AS setup_id,
  su.coffee_id,
  -- The last event at or before the shot: its "era", for grouping shots by
  -- what equipment and technique they were pulled with.
  (SELECT id FROM events WHERE at <= s.started_at ORDER BY at DESC, id DESC LIMIT 1) AS era_event_id
FROM shots s
LEFT JOIN setups su
  ON su.id = (
    SELECT id FROM setups
    WHERE valid_from <= s.started_at
    ORDER BY valid_from DESC, id DESC
    LIMIT 1
  )
LEFT JOIN coffees        c ON c.id = su.coffee_id
LEFT JOIN shot_overrides o ON o.shot_id = s.id
LEFT JOIN tastings       t ON t.shot_id = s.id
WHERE s.kind = 'shot';

-- Samples of what the machine itself is doing, which it records nowhere.
--
-- The firmware exposes no uptime, no boot time and no heat-up log, so the only
-- way to know when the machine was switched on — and how long the boiler took
-- to get there — is to watch it from outside. /api/status gives mode, target
-- and current temperature; unreachable means it is off, and after power-on it
-- drives itself to temperature on its own, which is what makes the curve a
-- power-on detector rather than just a thermometer.
--
-- Rows are written on change rather than on every poll (see machineState.ts):
-- dense while the temperature moves, sparse while it sits at setpoint.
CREATE TABLE IF NOT EXISTS machine_state (
  sampled_at   INTEGER PRIMARY KEY,   -- unix seconds
  reachable    INTEGER NOT NULL,      -- 0 = no answer, which means powered off
  mode         INTEGER,               -- 0 standby, 1 brew, 2 steam, 3 water, 4 grind
  target_temp  REAL,
  current_temp REAL
);

CREATE INDEX IF NOT EXISTS machine_state_reachable ON machine_state (reachable, sampled_at);
