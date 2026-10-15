# executor/src/harness — Deep Agents harness (Gate 1 feasibility)

Self-contained feasibility record for the executor-owned Deep Agents pilot.
Spec: `docs/superpowers/specs/2026-10-14-builder-deepagents-pilot-design.md`;
plan: `docs/superpowers/plans/2026-10-14-builder-deepagents-pilot.md`.
Everything here is verified fact about the PINNED versions below — if a claim
wasn't run on this machine, it says so explicitly.

## Pinned versions (recorded 2026-10-15 from `npm view <pkg> version`)

| Package | Version | Note |
| --- | --- | --- |
| deepagents | 1.15.0 | `createDeepAgent` composite backend API |
| langchain | 1.5.16 | `tool` DSL |
| @langchain/core | 1.2.17 | `BaseChatModel` |
| @langchain/langgraph | 1.5.0 | `Command`, `interrupt`, `MemorySaver`, `BaseCheckpointSaver` |
| @langchain/langgraph-checkpoint-postgres | 1.1.0 | `PostgresSaver` |
| @langchain/openai | 1.6.2 | `ChatOpenAI` |
| zod | 4.6.7 | deepagents declares `zod ^4.3.6` |

Pinned without ranges (`deepagents` + `@langchain/*`): Gate 1's whole purpose
is reproducible behavior; range upgrades change semantics. Bumping them is a
new feasibility record, not a chore.

## Probe findings (`probe.test.ts`, run 2026-10-15)

- `createDeepAgent`, `CompositeBackend`, `FilesystemBackend`, `StateBackend`,
  `LocalShellBackend` — all exported functions from `deepagents`.
- `Command`, `interrupt`, `MemorySaver`, `BaseCheckpointSaver` — all exported
  from `@langchain/langgraph`.
- `PostgresSaver` exported from `@langchain/langgraph-checkpoint-postgres`;
  `PostgresSaver.fromConnString` is a function. Task 6 uses
  `new PostgresSaver(pool)` first, `fromConnString` as fallback — the form
  that actually worked gets recorded below in the Task 6 section.
- `BaseChatModel` exported from `@langchain/core/language_models/chat_models`.
- `tool` exported from `langchain`.
- **`FakeToolCallingChatModel` does NOT exist** in `@langchain/core` 1.2.17's
  `utils/testing` (available: `FakeChatModel`, `FakeListChatModel`,
  `FakeStreamingChatModel`, …). The plan anticipated this drift: deterministic
  tests use our own scripted fake in `fake-model.ts` instead.

## Task records

### Task 2 — kill-cleanup facts (2026-10-15)

- TERM-ignoring process group reaped by the SIGKILL grace path; pid gone via
  `kill(pid, 0)` ESRCH within ~2.3 s after a 300 ms timeout (tool-runner
  suite, test 3).
- `HOME=<cwd>` and `TERM=dumb` are in the scrubbed base env; PATH passes
  through. Verified: `DATABASE_URL` and an injected `MARKER_SECRET` absent
  from children.

### Task 4 — model resolution (2026-10-15)

- ChatOpenAI 1.6.2 observable fields: `m.model`, `m.timeout`,
  `m.clientConfig.baseURL/.apiKey`. `modelName` and `maxRetries` are NOT
  exposed as instance fields (constructor accepts both).

### Task 5 — Deep Agents adapter (2026-10-15)

- `createDeepAgent({ model, backend, tools, systemPrompt, checkpointer })`
  works with a `BaseChatModel` subclass: a `bindTools` passthrough suffices;
  standard `AIMessage.tool_calls` drive the loop.
- `agent.stream(input, { configurable: { thread_id }, streamMode: ['messages','updates'], signal })`
  yields `[mode, data]` tuples; text arrives via `messages` mode (`token.text`
  on `ai` chunks); `updates.__interrupt__[].value` carries the `interrupt()`
  payload.
- `interrupt(payload)` inside a tool returns the `Command({ resume })` value;
  the tool result the model sees is the tool's returned text (verified: the
  second model call's ToolMessage content is exactly the user's answer).
- Tool timeouts do NOT end the agent loop — the ToolNode feeds the outcome
  string back and the model continues (test 3).
- Cancellation: langgraph stream's own `signal` does not by itself wake a
  stream parked on a pending model call — the watchdog's abort race is the
  working cancel surface, and any in-flight `run_command` receives the same
  abort signal. Verified in ~150 ms.
- Dispatch/result events are pushed from INSIDE the tool wrappers, never
  parsed from stream shapes.

### Task 6 — durable checkpoints, restart-resume (2026-10-15)

- `createCheckpointer(databaseUrl, schema)` creates a per-run schema and
  points `new PostgresSaver(pool, undefined, { schema })` at it (constructor
  form verified; `setup()` idempotent). `DROP SCHEMA … CASCADE` removes a
  run's state wholesale.
- **`durability: 'sync'` is mandatory in every `stream()` options bag.** The
  default async durability lets a question be VISIBLE in the consumer stream
  while its checkpoint write is still in flight — a restarted instance then
  sees only the stale `-1/0`-stage positions (empirically: only the input
  checkpoint committed).
- `getState().tasks[].interrupts` is EMPTY on a fresh instance for tool
  (`__pregel_push`) interrupts: the durable write carries the ORIGINAL task
  id, the fresh graph recomputes a different one, `tasksWithWrites` matches
  nothing. Discovery reads the newest tuple's `pendingWrites` directly and
  scans for the `__interrupt__` channel.
- `getTuple()` and `list()` DISAGREE on that same position: `getTuple`
  returns the newest checkpoint with `pendingWrites = []` while `list`
  carries the interrupt write. Discovery therefore uses
  `list({ configurable }, { limit: 1 })` (DESC = newest first).
- Questions are emitted only AFTER the run's stream quiesces, so consumers
  can never observe a question whose durable interrupt write has not
  committed (`durability:'sync'` narrows that window to a beat, not to zero).
- Exactly-once answers are enforced in the DRIVER (`answer()` returns `false`
  when no question with that id is pending); the checkpoint guarantees a
  resumed interrupt replays the tool exactly once.
- UUIDv6 checkpoint ids sort correctly by time (`DESC LIMIT 1` selects the
  newest position); the earlier "wrong position" observation was entirely
  explained by async durability.

## Known limits

_(Finalized at Task 7 — anything not yet proven is listed here instead of
being claimed.)_
