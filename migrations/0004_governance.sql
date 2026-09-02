-- Phase 3: capability tokens and budget ledgers.

CREATE TABLE capability_tokens (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES cases(id),
  obligation_id   TEXT NOT NULL REFERENCES obligations(id),
  action_id       TEXT NOT NULL,
  params_hash     TEXT NOT NULL,
  attempt_no      INTEGER NOT NULL,
  amount_cap      BIGINT,
  currency        TEXT NOT NULL DEFAULT 'INR',
  policy_version  TEXT NOT NULL,
  rule_id         TEXT NOT NULL,
  not_after       TIMESTAMPTZ NOT NULL,
  nonce           TEXT NOT NULL UNIQUE,
  minted_at       TIMESTAMPTZ NOT NULL
);

-- Single use is enforced here, by a unique index, rather than by a flag the
-- connector is trusted to check. A replayed token fails on insert.
CREATE TABLE token_burns (
  nonce      TEXT PRIMARY KEY,
  case_id    TEXT NOT NULL,
  action_id  TEXT NOT NULL,
  burned_at  TIMESTAMPTZ NOT NULL
);

-- Shared across every case and every incident for a customer: three cases
-- against one customer must not each get their own allowance.
CREATE TABLE contact_budgets (
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  channel       TEXT NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  used          INTEGER NOT NULL DEFAULT 0,
  cap           INTEGER NOT NULL,
  PRIMARY KEY (customer_id, channel, window_start)
);

CREATE TABLE policy_decisions (
  id              BIGSERIAL PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES cases(id),
  action_id       TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('allow','block','require_approval')),
  rule_id         TEXT NOT NULL,
  reason          TEXT NOT NULL,
  policy_version  TEXT NOT NULL,
  decided_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX policy_decisions_rule_idx ON policy_decisions (rule_id);
CREATE INDEX policy_decisions_case_idx ON policy_decisions (case_id, id);
