-- Additive; rollback is to stop advertising manualApprovals (retain history).
CREATE TABLE executor.manual_approvals (
  job_id UUID NOT NULL REFERENCES executor.jobs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resources JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','decision_recorded','delivered','expired','cancelled')),
  decision_id TEXT UNIQUE,
  decision TEXT CHECK (decision IN ('once','reject')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id,attempt,session_id,request_id)
);
