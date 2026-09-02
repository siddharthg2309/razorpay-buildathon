-- Phase 0/1 core tables.
--
-- Note on time: every timestamp is written by the application from an injected
-- Clock. No column has a now()/CURRENT_TIMESTAMP default, because a default
-- would quietly reintroduce wall time into paths the virtual clock is supposed
-- to govern. scripts/lint-clock.ts enforces this.

CREATE TABLE merchants (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  policy_version  TEXT NOT NULL
);

CREATE TABLE customers (
  id                 TEXT PRIMARY KEY,
  merchant_id        TEXT NOT NULL REFERENCES merchants(id),
  contact_prefs      JSONB NOT NULL DEFAULT '{}'::jsonb,
  consent_flags      JSONB NOT NULL DEFAULT '{}'::jsonb,
  language           TEXT NOT NULL DEFAULT 'en'
);

CREATE TABLE obligations (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  type          TEXT NOT NULL,
  amount_paise  BIGINT NOT NULL CHECK (amount_paise >= 0),
  currency      TEXT NOT NULL DEFAULT 'INR',
  due_at        TIMESTAMPTZ NOT NULL,
  external_ref  TEXT NOT NULL,
  state         TEXT NOT NULL,
  -- The obligation is the unit of money. Dedup is on (merchant, external_ref):
  -- a payment failure and an abandonment timer for the same order must attach
  -- to one obligation rather than opening two.
  UNIQUE (merchant_id, external_ref)
);

CREATE TABLE cases (
  id               TEXT PRIMARY KEY,
  obligation_id    TEXT NOT NULL REFERENCES obligations(id),
  incident_id      TEXT,
  domain           TEXT NOT NULL,
  state            TEXT NOT NULL,
  tier             SMALLINT NOT NULL DEFAULT 0,
  holdout_flag     BOOLEAN NOT NULL,
  next_seq         BIGINT NOT NULL DEFAULT 0,
  opened_at        TIMESTAMPTZ NOT NULL,
  closed_at        TIMESTAMPTZ,
  terminal_reason  TEXT
);

CREATE INDEX cases_obligation_idx ON cases (obligation_id);
CREATE INDEX cases_incident_idx ON cases (incident_id) WHERE incident_id IS NOT NULL;

-- Authoritative ordered input. seq is allocated inside the case row lock, so
-- concurrent events for one case serialise instead of colliding here.
CREATE TABLE case_events (
  id           BIGSERIAL PRIMARY KEY,
  case_id      TEXT NOT NULL REFERENCES cases(id),
  seq          BIGINT NOT NULL,
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  source       TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (case_id, seq)
);

-- Output of the deterministic event reducer.
CREATE TABLE case_revisions (
  case_id              TEXT NOT NULL REFERENCES cases(id),
  revision             BIGINT NOT NULL,
  state_json           JSONB NOT NULL,
  reduced_through_seq  BIGINT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (case_id, revision)
);

CREATE TABLE evidence (
  id           TEXT PRIMARY KEY,
  case_id      TEXT NOT NULL REFERENCES cases(id),
  kind         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  source       TEXT NOT NULL,
  observed_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX evidence_case_kind_idx ON evidence (case_id, kind);

-- Append-only decision and side-effect audit. Distinct from case_events:
-- events are input, ledger is what the system decided and did.
CREATE TABLE ledger (
  id              BIGSERIAL PRIMARY KEY,
  case_id         TEXT NOT NULL,
  ts              TIMESTAMPTZ NOT NULL,
  actor           TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  policy_version  TEXT
);

CREATE INDEX ledger_case_idx ON ledger (case_id, id);
