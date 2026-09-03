-- Promises to pay, and checkout sessions.
--
-- A promise is evidence, not money. It gets its own table precisely so it can
-- never be mistaken for a settlement: nothing joins it to the recovery figures,
-- and a case only reaches RECOVERED through a matched settlement.

CREATE TABLE promises_to_pay (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES cases(id),
  obligation_id TEXT NOT NULL REFERENCES obligations(id),
  promised_at   TIMESTAMPTZ NOT NULL,
  promised_for  TIMESTAMPTZ NOT NULL,
  amount_paise  BIGINT,
  source        TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'open'
                CHECK (state IN ('open','kept','broken')),
  settled_at    TIMESTAMPTZ
);

CREATE INDEX promises_open_idx ON promises_to_pay (promised_for) WHERE state = 'open';
CREATE INDEX promises_case_idx ON promises_to_pay (case_id);

-- First-party checkout telemetry. Deliberately not a PSP webhook: abandonment
-- is our own funnel event, and inventing a provider event for it would blur the
-- simulated/live boundary the whole demo rests on.
CREATE TABLE checkout_sessions (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL REFERENCES merchants(id),
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  external_ref   TEXT NOT NULL,
  amount_paise   BIGINT NOT NULL,
  last_stage     TEXT NOT NULL,
  last_active_at TIMESTAMPTZ NOT NULL,
  completed_at   TIMESTAMPTZ,
  case_id        TEXT REFERENCES cases(id),
  UNIQUE (merchant_id, external_ref)
);

CREATE INDEX checkout_open_idx ON checkout_sessions (last_active_at)
  WHERE completed_at IS NULL AND case_id IS NULL;
