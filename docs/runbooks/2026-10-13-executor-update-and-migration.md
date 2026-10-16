# Runbook — Updating the executor, systemd service stack, and database migration

**Date:** 2026-10-13
**Status:** Implemented and verified live (2026-10-12 22:52 install on this host); **code uncommitted — see §6**
**Scope:** `~/nexus-executor` on this host (office executor, native systemd stack)
**Related:** `2026-10-13-gateway-1011-hub-failure.md` (the still-open gateway issue)

## TL;DR

`make update` (or `bash ./install.sh`) is the entire workflow: pull latest code
(`--ff-only`), build, stop the executor, take a **validated** database backup,
apply schema migrations, (re)generate the three systemd user units, restart
everything, and verify. The one-time conversion from the old Podman/compose
deployment to the native stack — including the psql data migration into
`nexus-db` — is the same command with `--migrate-db`. Nothing is written until
backup, restore and migrations succeed; passwords and connection URLs are
preserved; the source database is never modified.

## 1. Routine update to latest code

```bash
cd ~/nexus-executor
git status --porcelain --untracked-files=no   # must be empty — or use --no-pull
make update                                   # = bash ./install.sh = nexus-executor update
```

What it does, in order (`scripts/install.mjs`):

1. `git pull --ff-only` (refuses uncommitted changes), then **re-runs the
   updated installer** — not the pre-pull version — for the remaining steps
2. `npm ci --include=dev` + `npm run build`
3. `loginctl enable-linger` (units start at boot without a login session)
4. Stops `nexus-executor.service` (quiesces the executor's writes)
5. Validated backup of the current database (§3 guarantees)
6. Restarts `nexus-db.service`, applies executor migrations
   (`dist/main.js --migrate-only`)
7. Rewrites `.env`, `executor.env`, `opencode.env` (mode 0600) and the three
   unit files; `daemon-reload` + `enable`
8. Restarts `opencode-executor.service` + `nexus-executor.service`; fails
   unless both report `is-active`

Variants:

```bash
make install ARGS="--no-pull"                 # install the current (e.g. uncommitted) checkout
bash ./install.sh --dry-run                   # print the plan, change nothing
make install ARGS="--gateway URL --code CODE" # install + pair in one command
```

Failure semantics: if anything fails **before** services are touched, nothing
changed; if it fails **after**, the executor may be stopped — fix the error and
rerun install.

## 2. The service stack the installer owns

| Unit | Role |
|---|---|
| `nexus-db.service` | Native PostgreSQL on `127.0.0.1:5556`; data in `~/.local/share/nexus-executor/postgres`; private socket `…/pg-socket` |
| `opencode-executor.service` | `opencode serve` on `127.0.0.1:4096`; password pinned in `~/.config/nexus-executor/opencode.env` (survives restarts; `OPENCODE_TOKEN` mirrors it) |
| `nexus-executor.service` | The executor. `Requires=nexus-db.service`, `Wants=opencode-executor.service`; `ExecStartPre` waits for the DB **and applies pending migrations on every boot** |

```bash
systemctl --user status nexus-db opencode-executor nexus-executor
systemctl --user restart nexus-executor
journalctl --user -u nexus-executor -f
# From a non-login context (cron, an agent shell):
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user <cmd>
```

## 3. One-time migration: old deployment → native stack (+ psql data migration)

This exact path ran successfully on 2026-10-12 22:52 (old Podman Postgres on
:5544 → native `nexus-db` on :5556; all five source tables + migration history
verified identical afterwards; source container and volume left intact).

```bash
# 1. Make the OLD database reachable (e.g. start the old Podman container).
# 2. From the executor checkout:
make db-backup                                 # standalone validated backup; changes nothing
make install ARGS="--migrate-db --no-pull"     # uncommitted checkout; drop --no-pull once committed
```

Guarantees (`scripts/database.mjs`):

- Dumps only the configured executor database; verifies the archive catalog
  and SHA-256; refuses empty backups and URLs carrying query options
- `initdb` a **separate** native cluster — never the source port; nonempty
  targets are rejected; no `DROP`, no `--clean`, no in-place data-directory
  migration, no source-container stop or volume deletion
- `pg_restore --single-transaction --exit-on-error --no-owner --no-acl`;
  role ownership remapped to the native executor role
- A retry after a completed restore **resumes** that target — it never
  overwrites or merges newer source writes
- `.env` switches to the native database **only after** restore and migrations
  succeed; the original URL is preserved in the backup's `source.env`
- Backups: timestamped mode-0700 directories under
  `~/.local/share/nexus-executor/backups` (`database.dump`, `manifest.json`,
  `source.env`). Nothing is auto-deleted; keep an off-machine copy.

### Rollback

```bash
systemctl --user stop nexus-executor
cp ~/.local/share/nexus-executor/backups/<stamp>/source.env ~/nexus-executor/.env
make install ARGS="--external-db --no-pull"    # regenerate services against the original DB
```

Do **not** discard the native cluster afterwards — post-cutover writes exist
only there.

## 4. Verification after any update or migration

```bash
systemctl --user is-active nexus-db opencode-executor nexus-executor
journalctl --user -u nexus-executor -n 20 --no-pager   # "enrolled with gateway" + gateway loop
nexus-executor status                                    # pairing/runtime state (--json available)
nexus-executor doctor --json
ss -ltnp | grep -E ':5556|:4096'                         # both loopback-only
```

Until the gateway 1011 issue is fixed, the log will still show the reconnect
loop — that is the server-side problem, not a bad update. A healthy gateway
session is one holding **≥ 30 s** (`STABLE_SESSION_MS`).

## 5. Manual database tools (behind the make targets)

```bash
make db-backup      # = node scripts/database.mjs backup
                    #   (settings from ~/.config/nexus-executor/native-db.json,
                    #    DATABASE_URL from env or <checkout>/.env)
```

Lower level: `node scripts/database.mjs init|provision|restore
[settings.json] [archive sourceId]` — the installer is the only supported
caller of `init`/`provision`/`restore`; `backup` is safe standalone.

## 6. Outstanding: commit the work

All of the above lives in **uncommitted** files: `scripts/` is untracked, and
`install.sh`, `Makefile`, `README.md`, `src/cli/cli.ts`, `src/cli/update.ts`,
`src/gateway.ts`, `src/gateway.test.ts` are modified. The installer **refuses
`git pull` over uncommitted changes**, so the routine update path in §1 is
blocked until this lands (that is why the 2026-10-12 install needed
`--no-pull`). Commit before the next update.
