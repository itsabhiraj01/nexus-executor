-- Runs with search_path = executor, public
-- Durable registry for tmux-backed terminal sessions (terminal.list's sync /
-- backfill — see docs/executor.md §Terminal sessions): every session on the
-- executor's tmux server — console-created OR made by hand — gets a stable
-- `nxt-*` public id resolved through the tmux-NATIVE identity (server, native
-- $id, native creation time). tmux names are mutable and meaningless across
-- server restarts, so identity never keys on them.
CREATE TABLE executor.terminal_sessions (
  public_id       TEXT PRIMARY KEY,          -- nxt-<hex> — the id the hub/console uses
  tmux_server     TEXT NOT NULL,             -- tmux server identity (socket path + start time + pid)
  tmux_session_id TEXT NOT NULL,             -- tmux' own session id ($N) — rename-proof within a server
  tmux_created_at TIMESTAMPTZ NOT NULL,      -- tmux' session_created (a fresh server may reuse $N)
  tmux_name       TEXT NOT NULL,             -- the (mutable) tmux session name, as last seen
  name            TEXT NOT NULL,             -- display name; tracks renames for imported sessions
  origin          TEXT NOT NULL CHECK (origin IN ('created','imported')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when the executor first registered it
  last_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- last input/resize/attach activity
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- last successful inventory that included it
  exited_at       TIMESTAMPTZ,               -- NULL while live; stamped when a scan finds it gone
  UNIQUE (tmux_server, tmux_session_id, tmux_created_at)
);

-- The console shows recently-exited sessions for ~10 minutes; the lookup of
-- fresh tombstones runs on every terminal.list.
CREATE INDEX terminal_sessions_exited_idx ON executor.terminal_sessions (exited_at)
  WHERE exited_at IS NOT NULL;
