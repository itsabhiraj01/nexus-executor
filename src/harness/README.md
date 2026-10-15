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

_(Appended per plan task — Task 2 kill-cleanup facts, Task 5 stream shapes,
Task 6 PostgresSaver form + resume semantics, Task 7 smoke/probe results.)_

## Known limits

_(Finalized at Task 7 — anything not yet proven is listed here instead of
being claimed.)_
