# Remote attachment / skill acceptance evidence

Workflow: `fd7e3dc9-b105-4439-9af6-c83ee42259c1`.
Hub acceptance contract read from `job-fac7d259-e42`, revision
`6769eca8750eeb1a22479c9341dc0f2f62dd6ade`,
`docs/remote-attachments-verification.md`.
Executor baseline: `0d5e005` (includes dependency repair and selected-skill
delivery). This document and `src/remote-materialization.acceptance.test.ts`
are the separately scoped executor evidence, not a hub dispatch-stub result.

## Boundaries

All executor database writes use the existing guarded, per-run private
`nexus_executor_run_*_test` database. Git repositories, PNGs, skill bundles,
gateway identities and worktrees are disposable fixtures under
`/tmp/opencode/executor-materialization-*`. No dependency installation or
node_modules changes are involved. No production executor job, hub workflow,
gateway deployment, service configuration, or dirty-main file is changed.

Direct tests use authenticated HTTP over a real loopback Fastify listener.
Gateway tests use a real loopback WebSocket and the production
`runGatewayLoop` dispatcher. Enrollment is fixture-only; the separately
deployed gateway relay, hub connect-proof validation, root deployment and
public networking are **not** exercised by this executor suite.

Only the OpenCode client used for ordinary engine turns is scripted. Actual
engine launch/materialization, PostgreSQL events, filesystem contents,
git add/commit and transport-triggered merge all execute for real.

## Checks performed over BOTH transports

- A binary 1x1 PNG is reconstructed byte-for-byte in both actual
  `builder-input/diagram.png` and `builder-input/diagram-2.png` files.
  Traversal/dot-prefixed duplicate names produce those exact paths in the
  actual submitted prompt.
- `SKILL.md` and `references/fixture.txt` are installed with exact contents;
  the persona is pinned and `AGENT_APPLIED` records the skill digest.
- `git add -A`, engine checkpoint commits and transport-triggered merge
  include only the public feature change, never attachment or injected
  skill/persona bytes.
- A tracked skill overlay replaces the entry and removes stale resources in
  the worktree, while preserving the source checkout and original tracked
  skill contents through commit and merge.
- Tracked attachment collisions, directory symlinks, file symlinks and
  dangling file symlinks fail setup before **any** attachment in the batch
  is written and before session creation. Outside fixture targets remain
  unchanged.
- Git exclude resolution and filesystem failures stop launch before PNG
  writes. Skill-only exclude failures and a symlinked skill root stop before
  skill/resource writes.
- A delivered bundle missing `SKILL.md` receives HTTP/protocol 400 and no
  accepted database job.

## Reproduced defects and fix

Before the fix, eight acceptance cases failed (four cases per transport).
The assertions demonstrated actual PNG overwrites of tracked files and
outside symlink targets, including creating a dangling target. A git exclude
does not protect tracked files, and `writeFile` follows symlinks.

`materializeJobAttachments` now validates the real attachment directory,
rejects tracked paths, sanitizes/preflights the entire destination batch,
then persists the exclude before writing private bytes. Leaf opens use
`O_NOFOLLOW` and mode 0600. Existing normal files remain re-materializable.
These checks do not claim an OS sandbox against a separate hostile process
concurrently swapping ancestor directories or modifying git state.

## Real OpenCode checks (opt-in, no model execution)

The opt-in tests use the executor's configured OpenCode URL/authentication,
not an invented provider/model. They access only fixture locations and
create/delete one disposable session per transport, pinned to the
materialized fixture persona with deny-by-default tool permissions. They
send **no prompt** and activate skills with `resume:false`.

Verified against the configured service:

1. `GET /api/skill` discovers the installed fixture ID/description at the
   exact worktree location. Discovery is asynchronous; the test polls for
   at most five seconds and also checks an unignored control fixture.
2. `GET /api/fs/read/*` returns exact `SKILL.md`, companion-resource and PNG
   bytes from that location.
3. Native skill activation returns 204 and appends a real `skill` message
   containing the delivered instructions.
4. Activation of an absent fixture ID returns 404 naming the missing skill.
5. Session history contains no assistant/idle generation; the fixture
   session is deleted in `finally`.

This proves real discovery, native loader activation and resource
availability. It does **not** prove an LLM chose/called the `skill` tool,
read the companion with a tool, interpreted the PNG, or followed the loaded
instructions. Those provider-backed behavior checks remain a distinct gate
if required; no persona model chain, model fence, canary or permissions on a
user session were bypassed to manufacture evidence.

## Reproduction

Run from the isolated executor checkout:

```bash
npm run build
DATABASE_URL=postgres://nexus:nexus@localhost:5544/nexus_executor_test npm test -- src/remote-materialization.acceptance.test.ts
DATABASE_URL=postgres://nexus:nexus@localhost:5544/nexus_executor_test npm test
```

The normal acceptance suite has 22 automated cases; two real-OpenCode cases
are opt-in. To include them using the deployed executor's existing auth
without printing secrets (the explicit test URL takes precedence over the
env file):

```bash
DATABASE_URL=postgres://nexus:nexus@localhost:5544/nexus_executor_test \
EXECUTOR_ACCEPTANCE_REAL_OPENCODE=true \
node --env-file=/home/server/services/deployments/nexus/executor/.env \
  node_modules/vitest/vitest.mjs run src/remote-materialization.acceptance.test.ts
```

Keep the final test path when importing runtime environment variables. Two
attempts at the full suite with runtime settings exposed existing
environment-sensitive CLI fixtures: importing the whole env file caused
four pairing/repair failures; importing only the OpenCode URL/token caused
two repair failures. They are not evidence against materialization, but
those invocations are **not** claimed green. The separate clean-environment
full run passed **38/38 files, 373 tests passing and two opt-in tests
skipped**. The targeted opt-in run passed **24/24**, including both real
OpenCode checks. Initial red: eight real side-effect regressions.

No deployment or main merge is authorized by these results.
