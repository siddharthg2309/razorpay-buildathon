-- Phase 1: obligation leases and the durable scheduler.

-- Exactly one actor may act on an obligation at a time. Acquired at execution
-- admission, not at deliberation fan-out: specialists are read-only, and a
-- lease held across a slow provider call can expire mid-flight and let a
-- second worker act on the same money.
CREATE TABLE obligation_locks (
  obligation_id  TEXT PRIMARY KEY REFERENCES obligations(id),
  holder         TEXT NOT NULL,
  acquired_at    TIMESTAMPTZ NOT NULL,
  expiry         TIMESTAMPTZ NOT NULL
);

CREATE TABLE scheduled_actions (
  id             BIGSERIAL PRIMARY KEY,
  case_id        TEXT NOT NULL REFERENCES cases(id),
  obligation_id  TEXT NOT NULL REFERENCES obligations(id),
  fire_at        TIMESTAMPTZ NOT NULL,   -- virtual clock
  action_ref     JSONB NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','leased','done','cancelled')),
  lease_owner    TEXT,
  lease_expiry   TIMESTAMPTZ,
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL,
  settled_at     TIMESTAMPTZ
);

-- The tick worker's access path: due pending rows in fire order.
CREATE INDEX scheduled_actions_due_idx
  ON scheduled_actions (fire_at)
  WHERE state = 'pending';

-- Cancel-on-terminal sweeps by case.
CREATE INDEX scheduled_actions_case_idx
  ON scheduled_actions (case_id)
  WHERE state IN ('pending','leased');

-- Reclaiming crashed workers' leases.
CREATE INDEX scheduled_actions_lease_idx
  ON scheduled_actions (lease_expiry)
  WHERE state = 'leased';
