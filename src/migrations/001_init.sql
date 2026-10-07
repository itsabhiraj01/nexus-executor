-- Runs with search_path = executor, public
CREATE TABLE executor.config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE executor.jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_job_id TEXT NOT NULL UNIQUE,              -- the hub execution id (idempotency)
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN
    ('created','queued','running','waiting_for_user','verifying','failed','succeeded','cancelled')),
  title TEXT NOT NULL DEFAULT '',
  spec JSONB NOT NULL,                           -- the full job spec as received
  prompt TEXT NOT NULL DEFAULT '',
  verification_command TEXT NOT NULL DEFAULT '',
  verification_attempt_count INTEGER NOT NULL DEFAULT 0,
  branch TEXT NOT NULL DEFAULT '',
  worktree_path TEXT NOT NULL DEFAULT '',
  opencode_session_id TEXT,
  model TEXT NOT NULL DEFAULT '',
  failure_reason TEXT,
  error_code TEXT,
  summary TEXT NOT NULL DEFAULT '',
  merged_sha TEXT NOT NULL DEFAULT '',
  event_seq BIGINT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX jobs_status_idx ON executor.jobs (status) WHERE status IN ('created','queued','running','waiting_for_user','verifying');
CREATE INDEX jobs_updated_idx ON executor.jobs (updated_at);

CREATE TABLE executor.job_events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES executor.jobs(id) ON DELETE CASCADE,
  sequence_number BIGINT NOT NULL CHECK (sequence_number > 0),
  event_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'opencode' CHECK (source IN ('executor','opencode','hub')),
  summary TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  message_id TEXT,                              -- opencode message/part id (dedupe aid)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, sequence_number)
);
