# Design — Projects living on the executor (mandatory dir path, optional autodetect git remote)

**Date:** 2026-10-08
**Status:** Approach decided & design final. Executor side (registry + CLI + name-resolution) and hub side (schema + dispatch) implemented with tests; coordinated deploy still pending.
**Scope:** `nexus-executor` + `nexus` (builder module) + `nexus-gateway` (only if dispatch payload shape changes)
**Author:** debugging/design session

## 1. Goal

Make the **executor** the owner of a project's working copy, so the builder can always run a job against a **project registered inside a specific executor**:

- **Mandatory** local **directory path** (the project physically lives on the executor's filesystem).
- **Optional** **git remote**, **autodetected from the repo** when unset (read `origin`, or allow an explicit URL).
- The builder dispatches to an executor by **project identity** (executor + dir path), not by shipping hub-side paths/clones.
- Pipeline: **PR-raise stage after rebase**; auto-merge **rebases on conflict** (bounded); **human-readable `feat|feature|fix/<slug>` branch names**.

## 2. Current behavior (verified against code)

### Hub side
- Projects are hub-side rows in `builder.projects` (`name`, `repo_url`, `local_path`, commands, `executor_id`, …). `local_path`/`repo_url` are **hub-local** values.
- At remote dispatch (`builder/src/engine.ts:1290`), the hub sends the **hub's own** `project.repoUrl` / `project.localPath` verbatim in `RemoteJobSpec.project`. There is no executor-side validation, and the path is the hub's path, not the executor's.

### Executor side
- On `job.dispatch`, `validateJobBody` (`ops.ts:97`) requires `project.localPath` **or** `project.repoUrl`.
- `engine.ts:547-549` resolves the work dir: use `project.localPath` if set, **else clone** `project.repoUrl` into `<workspaceRoot>/repos/<sha1(url)>.slice(0,12)` and reuse/pull.
- Per-run isolation is via `git worktree` under `<workspaceRoot>/worktrees/<branch>`.
- Git remote autodetect already exists implicitly: the executor reads/clones by URL; the local-path path does **not** currently derive a remote from the repo on the executor.

### Gap
- There is **no project registry on the executor** (no durable list of "this executor owns project X at dir `Y`").
- The builder cannot **reference a project by executor-side dir path** reliably: it currently forwards hub-side paths.
- `repoUrl`/`localPath` are both **optional** in the model; the user wants **dir path mandatory** and **git remote optional + autodetected**.

## 3. Proposed model

> **Decisions locked in (2026-10-08 review):** all recommended options adopted —
> (a) link hub projects to the executor by **executor project name/id**, not raw
> dir paths; (b) keep **per-run `git worktree`s** rooted at the registered repo
> (isolated branches), not in-place edits; (c) **allow plain non-git dirs** when no
> remote is set; (d) wire up **remote push + merge** against `origin`. Plus new
> pipeline requirements: an explicit **PR-raise stage after rebase**, auto-merge
> **auto-rebases on conflict**, and **human-readable branch names** (`feat|feature|fix/<slug>`).

### 3.1 Executor-side project registry (new, durable on the executor machine)

A per-executor table/list of registered projects:

```
executor_projects:
  id            uuid
  name          text        unique within executor
  dir_path      text        NOT NULL  — absolute path on THIS executor machine (mandatory)
  git_remote    text        NULL      — optional; autodetected from repo 'origin' when unset
  build/run/test_command   text NULL — optional overrides
  custom_prompt text        NULL
  created_at, updated_at
```

- `dir_path` is **mandatory** and validated to exist (and be a git work tree if `git_remote` is set).
- `git_remote` **optional**: when unset and the dir is a git repo, autodetect from `git -C <dir> remote get-url origin`; reject a bare non-git dir only if the build needs a repo — otherwise allow plain dirs for non-git work.
- Registration surface on the executor: local CLI (`nexus-executor project add|list|rm`), not (by default) a network endpoint.

### 3.2 Hub-side project row carries a reference to the executor project

Keep `builder.projects` as the routing row but change semantics for executor-targeted projects:
- `executor_id` (already exists) → which executor owns it.
- **New/repurposed** field(s) to reference the executor-side project: either
  - `executor_project_name` (link by registered project name), **or**
  - store the **`dir_path`** directly on the hub project when `executor_id` is set.
- Recommendation: link by a stable **executor-local project id/name**, and have the builder resolve it at dispatch to `{dir_path, git_remote}` (so the executor is the single source of truth for its own paths). This avoids the hub shipping a wrong/absolute executor path.

### 3.3 Dispatch payload

`RemoteJobSpec.project` grows/contracts:
- Always send the **resolved** `dir_path` (the executor-registered path) as `project.localPath` (mandatory for executor-registered projects).
- Send `repoUrl` only if a remote is pinned; otherwise omit (the executor autodetects from the repo).
- The executor's resolver (`engine.ts:547`) becomes: **validate the dir exists** → use it directly → autodetect/push/pull the git remote as configured (no ephemeral clone for registered projects). Unregistered/clone paths remain for legacy/back-compat.

### 3.4 Worktree / isolation & git lifecycle

Per-run work is a `git worktree` rooted at the registered repo's shared checkout, so parallel runs don't collide and a push/merge is safe.

**Human-readable branch names (new).** Today branches are opaque `builder/exec-<execution-id>` (`worktree.ts:worktreeBranchName`). Change to a readable slug with a conventional prefix:

```
<prefix>/<slug>-<short-exec-id>       e.g. feat/login-page-a81b2c3, fix/pricing-null-91d0f2
```

- `prefix` from intent: `feat/`, `feature/` (equivalent, normalized) or `fix/`.
- `slug` = slugified entry/project title (~40 chars) + short execution-id suffix for uniqueness.
- Keep a stable `branch` value on the execution so the hub can re-resolve the branch for merge/PR/log. Generate the new style going forward; still read old-style branches in legacy runs (a `git branch -m` backfiles in-flight worktrees only if we choose to rename).

### 3.5 Pipeline: PR-raise stage after rebase; auto-merge rebases on conflict

Current stage order (`pipeline.ts`): `plan → code → test → rebase → review`. `rebase` is presently lazy (only on conflict). Two requirements fold in:

1. **PR-raise stage after rebase.** Add an explicit `pr` stage between `rebase` and `review`: push the run's branch to `origin` and open a PR against the base ref (`createPullRequest`, `worktree.ts:588`, already exists; `WORKTREE_PR_CREATED` / `PR_CREATED` events exist). Record the PR URL as the stage outcome. Opt-in per project/entry (a "raise PR" flag); for executor-owned repos the push targets the executor's configured `origin` remote.
2. **Auto-merge auto-rebases when required.** Today `mergeWorktreeBranch` (`worktree.ts:505-507`) returns `conflicts` and **refuses** the merge on `merge-tree` exit 1. When `auto_merge` is enabled, change the landing flow to **auto-rebase on conflict instead of refusing**: drive the existing pull-base-into-worktree plumbing (merge base INTO the worktree, resolve markers via the rebase agent — `rebasePrompt`), commit the resolved rebase, re-run `mergeWorktreeBranch`, and loop (bounded rounds, e.g. 3, then surface conflicts for manual resolution). Gated by `auto_rebase`; without it the current refuse-and-surface behavior stands.

## 4. Changes by repo

### `nexus-executor`
1. **Migration**: create `executor_projects` table.
2. **CLI**: `nexus-executor project add <name> --dir <abs> [--remote <url>]`, `list`, `rm`, `show`; autodetect remote from `git -C <dir> remote get-url origin` when `--remote` omitted.
3. **Dispatch resolver** (`engine.ts:resolveWorkDir`): for registered projects, **require** `dir_path`, validate existence, autodetect/pull git remote; keep `cloneRepo` path only for unregistered/`repoUrl`-only jobs (back-compat).
4. **`opStatus` / capabilities**: advertise `projectRegistry: true` so the hub knows it can dispatch by executor project.
5. **Protocol back-compat**: `nexus.executor.v1` request `job.dispatch` payload still accepts `project.localPath` (+ optional `repoUrl`); no wire-break. Add an optional `project.projectId` field if we link by id.

### `nexus` (builder)
1. **Schema**: `builder.projects` — when `executor_id` set, require a reference to the executor project (`executor_project_name`). Keep `repo_url` optional; `local_path` becomes either the hub-local path (local runs) **or** the executor path reference (executor runs).
2. **Dispatch** (`engine.ts:1290`): when the target executor advertises `projectRegistry`, resolve the project's executor-side `{dir_path, git_remote}` via a single (cached) lookup (or carry the registered project id); send that `localPath`.
3. **Project create/update form**: make `dir path` mandatory for executor-targeted projects; make `repo url` optional with an "autodetect from the repo" hint; validate `executor_id` exists and is active.
4. **Branch naming** (`worktree.ts:worktreeBranchName`): produce `feat|feature|fix/<slug>-<short-exec-id>` from the entry/project title; keep the old `builder/exec-<id>` readable in legacy runs; store the branch on the execution for merge/PR/log resolution.
5. **PR-raise stage** (`pipeline.ts`, `engine.ts`): add explicit `pr` stage after `rebase` (+ after `review` if reordered); call `createPullRequest` and record the PR URL as the stage outcome; gate on a per-project/entry "raise PR" flag.
6. **Auto-merge rebase-on-conflict** (`engine.ts:mergeWorktreeBranch` caller): when `auto_merge` is on, intercept the `conflicts` result and drive the rebase/conflict-resolution loop (bounded rounds) instead of refusing; surface unresolved conflicts for manual handling after the bound.
7. **Health/UX**: surface the executor-side project dir + autodetected remote + PR/branch in the Executors/project UI.

### `nexus-gateway`
- Only if we extend the wire shape (`nexus.executor.v1` request schemas). Adding an **optional** `projectId` field touches `REQUEST_SCHEMAS['job.dispatch']` and the executor's `validateJobBody`. Must keep strict-schema rules (extra fields rejected) in sync across gateway protocol + hub `GATEWAY_OPERATIONS` + executor `ops.ts`. Prefer adding a new **optional** version-tolerant field rather than changing required semantics.

## 5. Back-compat & migration

- Existing hub `builder.projects` rows keep `repo_url`/`local_path`; only **new** executor-targeted projects adopt the mandatory-dir model.
- Legacy executors (no `projectRegistry`) keep receiving `repoUrl`/`localPath` as today and clone as before.
- Provide a one-way migration path: hub operator links existing projects to a registered executor project (`executor_project_name`), and the executor backfills `dir_path` from an existing local checkout if it can be found, else creates a fresh dir/remote bookmark.

## 6. Edge cases & open questions

1. **Shared repo, many executors**: each executor owns its own `dir_path` copy (remote sync optional). No single shared checkout across machines.
2. **Remote autodetect failure** (dir exists but not git, and no `--remote`): **resolved** — allow plain non-git dirs (non-git work is permitted); only fail if the job explicitly needs a repo and none is present.
3. **Push/merge semantics**: **resolved — in scope.** The executor `git push`es the run's branch to `origin` and the hub's `job.merge`/`job.log` operate on the shared checkout's repo, with the executor's autodetected remote as `origin`. The existing local merge path is extended to auto-rebase on conflict (bounded rounds) rather than refuse.
4. **Directory moves**: the executor is the authority; the hub only stores a reference. Re-pointing a project = update the executor registration + hub reference.
5. **Security**: `dir_path` is an arbitrary absolute path on the executor — CLI-only registration (no unauthenticated network surface), and the dispatch carries a **reference**, not a raw path from the hub.
6. **Isolation**: **resolved** — keep per-run `git worktree` rooted at the registered repo (isolated branches), not in-place edits.
7. The four existing projects ("Nexus", "Nexus Gateway", "Nexus Executor", "Service Deployer") are all pinned to the **broken** executor `65548050`; re-pairing or re-pointing them is part of rollout.

## 7. Suggested implementation order

1. Executor: project registry migration + CLI + resolver (self-contained, testable without the hub).
2. Hub: schema + dispatch changes keyed on the `projectRegistry` capability (back-compat preserved).
3. Wire/protocol changes (only if adding a `projectId` / PR fields) across `nexus-gateway` + hub + executor with strict-schema updates and tests.
4. Hub: branch-naming (`feat|feature|fix/<slug>-<id>`), PR-raise stage (after rebase), and auto-merge-rebase-on-conflict loop in the landing flow.
5. UI form changes (mandatory dir, optional autodetect remote; surface PR/branch/remote in Executors).
6. Migration/backfill runbook for existing projects.

## 8. Is a dial-back URL still needed?

**No — not for the gateway transport you're using.** Executors that dial *out* to the gateway are reached through the queued gateway client (mailbox + correlated responses), never by the hub dialing them:
- `executor-worker.ts:60-63`: "reach them through the queued gateway client …, never a dialed URL."
- `base_url` is `NULL` by design for gateway executors (`gateway.ts:144` inserts `base_url = NULL`; `gateway.test.ts:89-90` asserts it). This `NULL` is exactly the `(null)` shown in the UI next to the name.

`base_url` is **only** used on the legacy `direct` transport path (`remote.ts:258`, `router.ts:648`, `engine.ts:1318` — `transport !== 'gateway'`). If/when direct executors are phased out, `base_url` (+ its `token_encrypted`) become removable entirely. For now they're dormant for gateway executors but still required by the direct code path — **no action needed** unless you decide to deprecate direct executors.

## 9. Out of scope for this iteration (flagged, not decided)
- Autodetecting the remote for **hub-side** local projects (different machine model).
- Cross-executor mirroring / high-availability of a project's checkout.
- Restricting `dir_path` to a whitelist under the executor workspace.
- Deprecating the `direct` transport / removing `base_url` + `token_encrypted` from the schema (would simplify the executor model but is a larger migration; flagged, not decided).

---

*Design decisions resolved (2026-10-08): link by executor project name; keep per-run git worktrees; allow plain non-git dirs when no remote set; remote push/merge in scope; PR-raise stage after rebase; auto-merge rebases on conflict (bounded rounds); human-readable `feat|feature|fix/<slug>` branch names; dial-back URL not needed for gateway executors.*