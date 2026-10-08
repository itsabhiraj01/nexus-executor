-- Runs with search_path = executor, public
-- Executor-owned project registry: the executor is the authority on where a
-- project's working copy lives (mandatory absolute dir_path) and what git
-- remote it tracks (optional; autodetected from the repo's 'origin' when
-- unset). The hub references these by name/id at dispatch instead of shipping
-- hub-side paths, so the executor never trusts a raw path from the network.
CREATE TABLE executor.projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,                      -- hub-facing identifier; unique per executor
  dir_path      TEXT NOT NULL,                      -- absolute path on THIS executor machine (mandatory)
  git_remote    TEXT,                               -- optional; autodetected from 'origin' when unset
  build_command TEXT,
  run_command   TEXT,
  test_command  TEXT,
  custom_prompt TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name),
  UNIQUE (dir_path)
);

CREATE INDEX projects_name_idx ON executor.projects (name);