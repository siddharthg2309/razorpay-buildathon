-- Phase 4: the execution record.
--
-- The row is written BEFORE the external call and updated after. That ordering
-- is the whole point: a crash between call and response leaves an in_flight
-- row, which boot-time reconciliation resolves by asking the PSP about the same
-- idempotency key rather than re-issuing the call.

CREATE TABLE action_attempts (
  id             TEXT PRIMARY KEY,
  case_id        TEXT NOT NULL REFERENCES cases(id),
  obligation_id  TEXT NOT NULL REFERENCES obligations(id),
  action_id      TEXT NOT NULL,
  attempt_no     INTEGER NOT NULL,
  idem_key       TEXT NOT NULL UNIQUE,
  surface        TEXT NOT NULL CHECK (surface IN ('live','simulated')),
  state          TEXT NOT NULL CHECK (state IN ('in_flight','succeeded','failed','reconciled')),
  request        JSONB NOT NULL,
  response       JSONB,
  sent_at        TIMESTAMPTZ NOT NULL,
  settled_at     TIMESTAMPTZ
);

CREATE INDEX action_attempts_case_idx ON action_attempts (case_id, sent_at);
CREATE INDEX action_attempts_in_flight_idx ON action_attempts (sent_at) WHERE state = 'in_flight';
