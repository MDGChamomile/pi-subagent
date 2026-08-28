# Pi Subagent Prototype

A foreground, model-invocable, single-run Pi subagent for isolating noisy local-file and public-web investigation from the parent context.

## In action

The status and result below came from a real local lookup against this repository and were rendered without machine-specific paths or account details.

**Running**

![Pi Subagent reporting elapsed time, child model, thinking level, and reported tokens while running](assets/pi-subagent-running.png)

**Complete**

![Pi Subagent reporting completion time, injected context size, and the expanded final answer](assets/pi-subagent-complete.png)

## Contract

- Activation: the model may select the visible `pi-subagent` skill or `pi_subagent` tool when a task matches; users may still invoke `/skill:pi-subagent`
- Runs: one child call by default and up to three started calls per parent agent run for distinct, independent research tracks; separate local and web calls each count toward the limit, sibling calls execute in parallel, and one corrected retry is allowed only after preflight validation failure
- Parent-owned validation gate: when the parent already holds edited files and evidence or may need follow-up fixes, final diff, audit, test, and retrieval validation stays in the parent rather than being delegated merely for an extra review pass
- Child process: one ephemeral `pi --mode json --print --no-session` process per call; a dedicated parent-liveness pipe makes the child remove its private runtime files and terminate its POSIX process group (the child process itself on Windows) if the parent exits abruptly
- Capabilities: `local` loads only Pi-owned `read`, `grep`, `find`, `ls`; `web` loads only web tools; local and web access never coexist in one child, so mixed-source work uses separate calls and parent synthesis
- Local prerequisites: child startup is forced offline so Pi cannot auto-download search binaries; `grep` requires an installed `rg`, while `find` requires `fd` or `fdfind`
- Web tools: `web_search`, `source_check`, `fetch_content`, `get_search_content` from the package-declared entry point of the installed `pi-web-access` package
- Local scope: 0-8 existing files or directories inside the parent cwd; `local` requires a non-empty scope and `web` requires an empty scope; a bare `@` is rejected rather than expanding to the parent cwd
- Web boundary: per-tool default-deny argument allowlists; non-interactive search with at most 4 queries and 10 results per query; readable HTTP(S) fetches of at most 5 URLs under the installed web extension's SSRF protection policy; no caller-selected provider/proxy, background content expansion, local-file fetch, browser-cookie auth, answer/model/media mode, embedded URL credentials, or forced GitHub clone; every denied input blocks only that call so the child may correct it
- Resources disabled: all discovered extensions, Skills, prompt templates, context files, themes, and project trust. Only the child guard and resolved web extension are explicitly loaded
- Readiness: the parent accepts a final answer only after the child guard validates policy and tool ownership and publishes a private readiness marker
- Return: the parent discards intermediate assistant messages and tool results, retains only the last non-tool assistant answer, sanitizes it, and caps it at 12 KiB; if an agent run ends without a final answer, the guard disables tools and requests ordinary assistant text once
- Progress: each running call reports its own `mm:ss · model (thinking) running · N reported tokens` status once per second
- Result display: the settled TUI row reports `✓ Complete · 14.2s · Context injected: ~1,820 tokens` (or `⚠ Partial`), using Pi's conservative character-based token estimate; expanding the row reveals the answer
- Timeout: 18 minutes of investigation followed by a two-minute text-finalization window within the existing 20-minute hard limit; at the soft deadline the child is steered to stop investigating, new tool calls are blocked, and a result completed in that window is runtime-labelled `partial`, while an unresponsive child is still terminated at the hard deadline

Three standard presets choose a proportionate child model without changing the main model's thinking:

- `lookup-standard` → Luna/low
- `analysis-standard` → Terra/medium
- `review-standard` → Sol/medium

Older stored calls with separate `profile` and `thinking` arguments, or with the former balanced/deep/exhaustive preset names, are translated by `prepareArguments()` to the matching standard preset before schema validation.

The companion progressively disclosed workflow is `../../skills/pi-subagent/SKILL.md`.

## Security boundary

The child guard canonicalizes every requested local path, replaces the tool input with that authorized canonical path, and blocks paths outside the explicit scope, including lexical, absolute, and symlink escapes. It independently checks that each enabled local tool is Pi-owned and each enabled web tool comes from the package-declared entry point of the installed `pi-web-access` package. The web extension loads before the guard so the guard is the final `tool_call` policy handler. Local runs do not resolve or load the web extension, and web runs have no file tools or local scope. If policy or ownership validation fails, no readiness marker is published and the parent rejects any assistant text the child may still produce.

Web access is deliberately narrower than the full `pi-web-access` surface and remains subject to that extension's SSRF protection policy. Each tool accepts only a pinned argument allowlist, so unknown future parameters fail closed for that call. Search uses the configured provider, disables curation and background content expansion, and enforces query/result caps. Fetching permits only bounded readable HTTP(S) URLs and rejects local paths, `file:` URLs, caller-selected proxies, authenticated browser-cookie fetches, answer/model/media options, URL credentials, and forced clones. A denied input does not weaken later validation: every corrected call is checked independently. The web extension may still make external provider requests and maintain its documented bounded cache or temporary files. Authorized local file contents, web tasks and queries, fetched public pages, and the final answer are sent to the applicable model or search providers.

This is an application-level capability boundary, not an OS or network sandbox. The child and the trusted web extension still run as the current user. Do not use it for untrusted workloads requiring host isolation or for secrets that must not be sent to configured providers.

Intermediate child assistant turns and investigation tool results are discarded. The collector accepts only the last assistant message when it contains non-empty text without a tool call or terminal model error. A tool-only ending gets one tool-disabled finalization follow-up; a zero-exit child that still has no final answer is rejected. At 18 minutes Pi's native steering message asks the child to stop new investigation and answer from gathered evidence, and the guard blocks new tool calls. Every error reaching the parent is control-character-sanitized and capped at 4 KiB; child failures also reserve space for content-free diagnostics such as the failure phase, exit and stop state, assistant completion mode, and tool-error count. Child process stderr is discarded. Reported child usage is attached to the parent tool result on both success and failure. Tasks, paths, assistant text, and tool-result contents are never included in failure diagnostics.

The prototype does not support workspace writes, Bash, tests, session-history access, project-controlled resources, recursion, background runs, or child-session persistence. Parallelism is limited to three independent foreground child calls per parent agent run and can multiply model, provider, and web-request usage.

## Evaluation

`python3 scripts/context_isolation_eval.py --mode context` runs matched direct-parent versus subagent cases without creating sessions. The first plain-final-answer three-case run retained 100% fact recall in both arms while reducing mean maximum parent prompt tokens by 89.2% and parent investigative tool-result bytes by 100%; it produced no raw tool syntax or post-result parent investigation. Treat these single-run deterministic fixture figures as bounded checks, not universal production estimates.

## Verification

```bash
node --experimental-strip-types --test extensions/pi-subagent/*.test.ts
python3 scripts/context_isolation_eval.py --mode smoke --capability local
python3 scripts/context_isolation_eval.py --mode smoke --capability web
```

The web smoke test reproduces the normal loader arrangement: pi-web-access tools stay registered for provenance checks but are inactive in the parent model. It fails if the parent activates `load_web_tools` or calls a web tool directly.

The default test suite includes unit tests and deterministic spawned-child integration tests for final-answer isolation, complete and partial outcomes, the one-attempt tool-disabled finalization path, empty final answers, bounded provider errors, cancellation, timeout escalation, abrupt parent exit, successful and failed usage aggregation, scope, recoverable web denials, and tool ownership. Opt-in live smoke tests should additionally verify model-selected activation, three-call enforcement and parallel execution, fourth-call denial, an allowed local read, an out-of-scope denial, a public web search/fetch, local-file and auth-fetch denial, progress timer cleanup, and temporary-file cleanup.
