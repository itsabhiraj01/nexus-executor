# Live job permissions

Executors advertising `livePermissions: true` accept an optional
`permissionPolicy` in a job dispatch, and later updates via
`POST /api/v1/jobs/:id/permissions` (body = policy) or gateway operation
`job.permissions` (payload = `{jobId, policy}`). The gateway must also advertise
`gatewayLivePermissions: true`. Unsupported routes are errors, not advisory
fallbacks.

Policy shape:

```json
{
  "revision": "template-policy-hash",
  "generation": 1,
  "rules": [{"action":"*","resource":"*","effect":"deny"}]
}
```

Revision is nonblank and at most 128 characters. Generation is a positive safe
integer. Rules contain 1–256 entries; action is nonblank and at most 200
characters, resource is nonblank and at most 2000. Strings exclude control
characters. Effects are `allow`, `deny`, or `ask`; unknown fields are rejected.
Rules use native OpenCode action names (`shell`, `subagent`, `edit`) and preserve
array order. The hub compiles the complete template policy, including deny-all.

The response is `{revision, generation, sessionId, applied}`. Before a session
exists the policy is durable and `applied` is false. Older generations and
conflicting equal-generation policies return 409. An identical update does not
repeat PATCH when that policy is already acknowledged for the current session
and attempt AND live readback still matches. Every reconciliation checks live
rules; manual session override drift triggers PATCH and another readback without
interrupting already-authorized tools. Concurrent requests can return the newer current acknowledgment;
callers must compare the returned revision/generation rather than assuming
their requested version was applied.

Migration `005_live_permissions` adds `jobs.permission_policy` and
`jobs.permission_applied`. Desired policy commits before network application,
so it survives failures, executor restarts, and job retries. Application holds
the job row lock across PATCH, GET readback, and acknowledgment: lifecycle
session/attempt/terminal writes cannot race that acknowledgment. Targets are
resolved exclusively from the stored job, never client-provided session IDs or
paths. Terminal jobs reject updates.

All prompts pass through `promptCurrent`, which applies desired policy to the
persisted session before sending. This includes initial prompt-tier launches,
replacement sessions, model fallback, verification repair and rebase repair.
Polling also retries unapplied policies before approval draining. A failed or
mismatching readback never records an applied acknowledgment.

Updates do not interrupt or restart OpenCode. They affect subsequent permission
checks, not tools already authorized. Pending approvals retain their ordinary
unattended rejection behavior. Legacy job specs without a policy remain valid.
