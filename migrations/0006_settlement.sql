-- Phase 5: money actually received.
--
-- Separate from action_attempts on purpose. An attempt is what we did; a
-- settlement is what arrived. A recovery requires both, and the pairing is the
-- reconciler's job — an unmatched inbound transfer (Smart Collect, B2B) is a
-- settlement with no attempt behind it.

CREATE TABLE settlements (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL REFERENCES merchants(id),
  obligation_id  TEXT REFERENCES obligations(id),
  amount_paise   BIGINT NOT NULL CHECK (amount_paise > 0),
  currency       TEXT NOT NULL DEFAULT 'INR',
  reference      TEXT,
  idem_key       TEXT,
  virtual_account TEXT,
  source         TEXT NOT NULL,
  matched_by     TEXT,
  received_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX settlements_obligation_idx ON settlements (obligation_id);
CREATE INDEX settlements_unmatched_idx ON settlements (received_at) WHERE obligation_id IS NULL;
CREATE UNIQUE INDEX settlements_idem_idx ON settlements (idem_key) WHERE idem_key IS NOT NULL;

ALTER TABLE obligations ADD COLUMN virtual_account TEXT;
CREATE INDEX obligations_virtual_account_idx ON obligations (virtual_account) WHERE virtual_account IS NOT NULL;
