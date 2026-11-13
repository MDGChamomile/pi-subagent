# Migration

## v0.9.0

### Call limits and result metadata

Each parent agent run now allows at most three child calls, including calls that
fail preflight validation. The previous corrected-retry exception is removed;
check task, scope and preset inputs before calling, and continue in the parent
when the call limit is exhausted.

Each child retains one tool-call limit: 48 attempts for local investigations and
40 for web investigations. Allowed and denied attempts both count. Soft-limit
warnings and separate lifetime web query/fetch-target budgets are removed;
per-call web input bounds, deadlines and tool-disabled finalization remain.
Web usage can therefore exceed the former aggregate query/fetch-target limits.

Host integrations must stop reading `queryCount`, `fetchTargetCount` and
`softLimitReached` from tool-result details or budget telemetry; these fields
are no longer emitted. Attempt, execution and denial counters and
`hardLimitReached` remain. The model-visible complete/partial result envelope
and its `tool_budget` reason are unchanged.

### Guard checks and supported platforms

The runtime no longer independently checks built-in local tool ownership, its
own parent tool source, or the child policy file's ownership, permissions and
canonical identity. Local children still load only the guard and Pi's built-in
read tools; policy structure, canonical scope enforcement, web tool provenance,
readiness and model-selection checks remain. This is an application-level
capability boundary, not an OS, network or credential-isolated sandbox.

Native Windows process fallbacks are removed. Use Linux (including Ubuntu on
WSL) or the supported macOS 15 Apple Silicon environment instead.

### Maintenance and verification

Local path admission is checked again after asynchronous path resolution, so a
read cannot begin after the investigation deadline or finalization has started.
Runtime lifecycle, result classification, budget tracking and diagnostics are
split into focused helpers, and package/document validation is strengthened.
The direct-versus-delegated evaluation scripts are retired to repository history;
opt-in live smoke checks remain and require separate provider-use authorization.
Historical evaluations do not validate this release.

Tool input schemas, presets and settings are unchanged. Pi 1.0.0 or later and
pi-web-access 0.33.0 or later remain the minimum supported versions. Ordinary
supported installations need no settings migration; integrations consuming the
removed metadata or relying on the former retry/budget behavior must adapt.
Offline checks do not establish live provider compatibility.

## v0.8.4

### Path identity and process cleanup

Local reads now reject canonical paths that Pi would normalize to a different
file, rather than forwarding an ambiguous target. Child process groups are
cleaned up after natural exits, including descendants holding output pipes open,
and parent-liveness monitoring remains active after session shutdown.

### Compaction and failure diagnostics

Compaction requests now use the same readiness and model-selection checks as
ordinary provider requests. Compactions after a final answer are cancelled;
other compactions remain subject to those checks and the parent's hard deadline.
Reported child usage now includes compaction summaries. Failure diagnostics
report only allowlisted tool names, using `unknown` for other names.

### Maintenance and compatibility

Runtime helpers, web argument rules and settings handling are consolidated, and
regression, evaluation, package and documentation validation are strengthened.
Tool schemas, preset arguments, settings, successful and partial result
envelopes, resource limits and capability boundaries remain unchanged. Offline
checks do not establish live provider compatibility.

No migration action is required for ordinary supported paths. If a local path
is rejected because Pi would normalize its canonical spelling differently, use
an unambiguous canonical path; do not rely on an alias that resolves to the same
ambiguous spelling. Pi 1.0.0 or later and pi-web-access 0.33.0 or later remain the
minimum supported versions.

## v0.8.3

### Budget persistence and failure guidance

If the child guard cannot persist budget telemetry, it now disables tools and
invalidates its policy before propagating the error. Later tool calls are
blocked, and the next provider request exits with the runtime guard code. The
call fails instead of returning a complete or partial result based on stale
budget telemetry. Startup and tool-source verification failures also provide
more specific guidance.

### Maintenance and verification

Runtime responsibilities are split into focused modules without changing tool
schemas, preset arguments, settings, successful or partial result envelopes,
or resource limits. Offline coverage now includes SDK tool-input mutation,
web request schema compatibility, process termination escalation, and macOS 15
arm64 validation. These checks do not establish live provider compatibility.
Installation and first-use guidance are consolidated in the root README.

No user action is required. Pi 1.0.0 or later and pi-web-access 0.33.0 or later
remain the minimum supported versions.

## v0.8.2

### Failure diagnostics

Pi's JSON mode emits delta-only `message_update` records without the
cumulative assistant message. The failure-observation collector now validates
these records by their `assistantMessageEvent`, so streaming updates count as
validated observations instead of marking observations incomplete and leaving
`toolBalance` null. Successful and partial result envelopes, limits, and
settings are unchanged.

### Maintenance

Guard failure handling is centralized, and unchanged budget snapshots are no
longer rewritten; fail-closed ordering is unchanged. The README adds a cover
image, which is also the Pi gallery image, and a redrawn architecture diagram.
No user action is required. The minimum Pi version and preset arguments remain
unchanged from v0.8.0.

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
