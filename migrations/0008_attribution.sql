-- Phase 8: attribution.

-- Holdout assignment is written once, at case creation, and never updated.
-- Re-randomising after the fact — even accidentally — would invalidate every
-- number downstream, so the column is immutable by trigger rather than by
-- convention.
ALTER TABLE cases ADD COLUMN stratum TEXT;
ALTER TABLE cases ADD COLUMN first_contact_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION reject_holdout_change() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.holdout_flag IS DISTINCT FROM OLD.holdout_flag THEN
    RAISE EXCEPTION 'holdout_flag is immutable once assigned (case %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cases_holdout_immutable
  BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION reject_holdout_change();

CREATE TABLE attribution_runs (
  id                     TEXT PRIMARY KEY,
  batch_id               TEXT NOT NULL,
  arm                    TEXT NOT NULL,
  treated_n              INTEGER NOT NULL,
  holdout_n              INTEGER NOT NULL,
  treated_recovered      INTEGER NOT NULL,
  holdout_recovered      INTEGER NOT NULL,
  treated_rate           REAL NOT NULL,
  holdout_rate           REAL NOT NULL,
  lift                   REAL NOT NULL,
  lift_ci_low            REAL NOT NULL,
  lift_ci_high           REAL NOT NULL,
  gross_recovered_paise  BIGINT NOT NULL,
  incremental_paise      BIGINT NOT NULL,
  incremental_ci_low     BIGINT NOT NULL,
  incremental_ci_high    BIGINT NOT NULL,
  excluded_treated       INTEGER NOT NULL,
  excluded_holdout       INTEGER NOT NULL,
  window_days            INTEGER NOT NULL,
  model_spend_paise      BIGINT NOT NULL DEFAULT 0,
  provider_calls         INTEGER NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL
);

CREATE INDEX attribution_runs_batch_idx ON attribution_runs (batch_id);
