-- Phase 2: the shared case blackboard.
--
-- Evidence already exists (0001). This adds the claim board and the agent-run
-- record, both keyed to the case revision they were computed against — that
-- binding is what makes a Tier 1 decision replayable.

CREATE TABLE agent_runs (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES cases(id),
  revision      BIGINT NOT NULL,
  role          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok','timeout','error','skipped')),
  input_hash    TEXT NOT NULL,
  provider      TEXT,
  model         TEXT,
  latency_ms    INTEGER,
  cost_paise    INTEGER,
  started_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ
);

CREATE INDEX agent_runs_case_idx ON agent_runs (case_id, revision);

CREATE TABLE claims (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES cases(id),
  revision        BIGINT NOT NULL,
  agent_run_id    TEXT REFERENCES agent_runs(id),
  role            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'valid'
                  CHECK (status IN ('valid','invalidated')),
  confidence      REAL,
  payload         JSONB NOT NULL,
  evidence_refs   TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL,
  invalidated_at  TIMESTAMPTZ
);

-- One live claim per role per case. A rerun invalidates the old one and writes
-- a new row rather than mutating, so the trail keeps both.
CREATE UNIQUE INDEX claims_live_role_idx
  ON claims (case_id, role)
  WHERE status = 'valid';

CREATE INDEX claims_case_idx ON claims (case_id, created_at);
