-- Structured-claim cache.
--
-- The provider is the only non-deterministic element in an otherwise
-- reproducible batch. Caching its validated output by role and input hash makes
-- a rehearsal reproduce exactly, which matters for a demo you intend to run
-- more than once, and means the second run costs nothing.
--
-- Cached by the input, never by the case: two cases with identical evidence
-- deserve the same answer, and keying on case id would defeat the purpose.

CREATE TABLE claim_cache (
  cache_key      TEXT PRIMARY KEY,
  role           TEXT NOT NULL,
  input_hash     TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  model          TEXT NOT NULL,
  payload        JSONB NOT NULL,
  usage          JSONB NOT NULL,
  latency_ms     INTEGER NOT NULL,
  hits           INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL,
  last_hit_at    TIMESTAMPTZ
);

CREATE INDEX claim_cache_role_idx ON claim_cache (role);
