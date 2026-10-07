-- Runs with search_path = executor, public
-- In-job retries: one job may run several attempts — the executor requeues
-- the SAME job (same branch, fresh session, continuation preamble) instead
-- of reporting the first transient failure to the hub. `attempt_count` is
-- the 1-based attempt currently (or last) running; `max_attempts` is the
-- resolved budget (spec.retry.maxAttempts → EXECUTOR_RETRY_MAX → 1 — one
-- attempt, the pre-retries behavior); `retry_backoff_until` spaces a
-- requeued attempt (rate-limit windows, box cooldowns).
ALTER TABLE executor.jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE executor.jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE executor.jobs ADD COLUMN retry_backoff_until TIMESTAMPTZ;

-- The admission scan ("which queued job may launch now") filters on this.
CREATE INDEX jobs_retry_backoff_idx ON executor.jobs (retry_backoff_until)
  WHERE retry_backoff_until IS NOT NULL;
