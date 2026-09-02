-- Phase 7: incident mode.

CREATE TABLE incidents (
  id            TEXT PRIMARY KEY,
  segment_key   JSONB NOT NULL,
  segment_label TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('open','releasing','closed')),
  detected_by   TEXT NOT NULL,
  z_score       REAL,
  p_value       REAL,
  baseline_rate REAL,
  observed_rate REAL,
  sample_n      INTEGER,
  rca           JSONB,
  release_stage INTEGER NOT NULL DEFAULT 0,
  opened_at     TIMESTAMPTZ NOT NULL,
  closed_at     TIMESTAMPTZ
);

CREATE INDEX incidents_open_idx ON incidents (opened_at) WHERE state <> 'closed';

CREATE TABLE incident_members (
  incident_id  TEXT NOT NULL REFERENCES incidents(id),
  case_id      TEXT NOT NULL REFERENCES cases(id),
  attached_at  TIMESTAMPTZ NOT NULL,
  released_at  TIMESTAMPTZ,
  PRIMARY KEY (incident_id, case_id)
);

CREATE INDEX incident_members_case_idx ON incident_members (case_id);
CREATE INDEX incident_members_parked_idx ON incident_members (incident_id) WHERE released_at IS NULL;

-- Rolling observations the detector tests against a seasonal baseline.
CREATE TABLE segment_windows (
  segment_label  TEXT NOT NULL,
  window_start   TIMESTAMPTZ NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  approvals      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (segment_label, window_start)
);

-- Same weekday + hour, trailing weeks, per segment.
CREATE TABLE segment_baselines (
  segment_label  TEXT NOT NULL,
  weekday        SMALLINT NOT NULL,
  hour           SMALLINT NOT NULL,
  attempts       INTEGER NOT NULL,
  approvals      INTEGER NOT NULL,
  PRIMARY KEY (segment_label, weekday, hour)
);
