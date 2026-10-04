# Migration

## v0.8.1

### Failure diagnostics and cleanup

Child failures after collector creation now include bounded, content-free
`observations` in the model-visible error diagnostics. These distinguish
validated event counts from unvalidated stream receipts; they are not a verified
execution trace. Consumers must not treat `toolBalance` as proof of active tools
or infer a stall's cause from these observations. Successful and partial result
envelopes are unchanged, and no additional persistent log is created.

Failed spawns without a PID no longer wait for process-group cleanup grace.
Spawned children retain the existing conservative cleanup behavior. Provider
error text is reset on each assistant message so later failures cannot reuse
stale error text.

### Verification and review guidance

Offline regression coverage now exercises the real SDK and built-in Codex SSE
provider payload hook, including model/thinking mismatch rejection before fetch
and a throwing-hook control. This does not establish live provider, WebSocket,
other-provider, or full CLI compatibility.

Contribution guidance adds a concise PR template and clarifies review completion
and external-contributor review policy. The minimum supported Pi version and
preset arguments remain unchanged from v0.8.0.

## v0.8.0

### Minimum Pi version

Pi Subagent now requires Pi 1.0.0 or later, raised from 0.99.1. Development dependencies and CI pin Pi 1.0.0. Update Pi before installing a release that includes this change; there is no compatibility path for older Pi versions.

### Legacy preset arguments

Calls must use the current `preset` names: `lookup-standard`, `analysis-standard`, or `review-standard`. The runtime no longer translates the former separate `profile`/`thinking` arguments or the balanced/deep/exhaustive preset names; such calls, including ones replayed from older stored sessions, now fail schema validation instead of running.
