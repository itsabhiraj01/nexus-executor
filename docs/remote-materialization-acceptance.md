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

The initial `837d7de` fix validated the real attachment directory, rejected
tracked paths and preflighted the destination batch. Independent review then
found two remaining blockers: hardlinked regular-file destinations and ignore
negations overriding `info/exclude`. See the follow-up evidence below; the
original `O_NOFOLLOW` destination open did **not** protect hardlinked inodes.
These checks do not claim an OS sandbox against a separate hostile process
concurrently swapping ancestor directories or modifying git state.

### Independent-review follow-up: hardlinks and effective git ignores

The follow-up tests first reproduced **10 failures**, five per transport:
second-attachment hardlinks overwrote a tracked fixture inode (including a
hardlink inserted after preflight), and `.gitignore` / later `info/exclude`
negations allowed private files to be written despite the exclusion line.

The updated implementation:

- Rejects a destination with multiple hardlinks during whole-batch
  preflight. The second-attachment regression checks both paths retain the
  original bytes, the tracked inode/device/link count stay unchanged, and
  the first attachment does not get written.
- Never opens an existing destination inode for writing/truncation. Each
  payload is written into an exclusively created, mode-0600 new inode,
  then renamed over the final leaf. A hardlink inserted after preflight is
  replaced without truncating its tracked target; temporary files are
  cleaned up. Ancestor-directory TOCTOU is explicitly **not** closed.
- Calls `git check-ignore --verbose --non-matching -z --stdin` using exact
  NUL-delimited stdin, not a shell. Checks every positive match and exact
  record/path, rejecting unmatched paths and negation patterns rather than
  accepting exit 0 (which only proves some path matched).
- Rechecks effective ignores after exclude setup on every invocation,
  including an existing exclusion line. Both final paths and private
  temporary paths must be ignored **before any payload write**.

Both transports cover new/existing exclude files with higher-priority
`.gitignore` negations, later negations in the exclude file itself, a
partially ignored batch, and negations affecting only temporary paths.
Static tracked-path and symlink guards remain covered.

The fresh independent re-review gate remains with the coordinator: review
the follow-up commit range `837d7de..HEAD`, especially `src/workspace.ts`,
the acceptance tests and these limits. This subagent has no reviewer-dispatch
tool; no independent approval is claimed by its own verification.

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

The updated acceptance suite has 36 automated cases; two real-OpenCode cases
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
initial full run passed **38/38 files, 373 tests passing and two opt-in tests
skipped**. The initial targeted opt-in run passed **24/24**, including both
real OpenCode checks. Those historical results apply to `837d7de` and do
not constitute independent approval of the follow-up.

Fresh follow-up verification after fixing both review blockers:

- `npm run build`: exit 0.
- Clean full suite: **38/38 files passed, 387 tests passed, two opt-in tests
  skipped** (389 total).
- The exact opt-in command above: **38/38 acceptance tests passed**, including
  the two real OpenCode discovery/activation/missing-skill/resource checks.
- No active user workflow/session or root gateway deployment was touched.

Independent reviewer brief: inspect `837d7de..HEAD` in this isolated worktree.
Requirements are whole-batch rejection of pre-existing hardlinked attachment
destinations, no existing tracked-inode truncation when a hardlink appears
after preflight, and actual Git-ignore proof for every final/staging path
after exclusion setup and before private writes. Test both transports,
new/existing excludes, partial matches and negations. Keep static tracked /
symlink guards and state ancestor-directory TOCTOU and LLM-behavior limits.
Return findings by severity; the subagent's green tests are not an
independent security approval.

No deployment or main merge is authorized by these results.
