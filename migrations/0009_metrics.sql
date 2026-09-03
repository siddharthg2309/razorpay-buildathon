-- Denormalised diagnosis facts on the case.
--
-- Derivable by joining evidence to the taxonomy, but the PS asks for recovery
-- rate broken down by cause, rail, gateway and issuer, and re-deriving the
-- cause on every read makes those breakdowns a join through config rather than
-- a query. The diagnosis is a decision, so recording it is also the audit
-- trail's job, not a convenience.

ALTER TABLE cases ADD COLUMN cause TEXT;
ALTER TABLE cases ADD COLUMN rail TEXT;
ALTER TABLE cases ADD COLUMN gateway TEXT;
ALTER TABLE cases ADD COLUMN issuer TEXT;

CREATE INDEX cases_cause_idx ON cases (cause) WHERE cause IS NOT NULL;
CREATE INDEX cases_rail_idx ON cases (rail) WHERE rail IS NOT NULL;
