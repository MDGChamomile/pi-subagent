# Pi Subagent

A foreground, model-invocable, single-run Pi subagent for isolating noisy local-file and public-web investigation from the parent context.

## Requirements

- Node.js 22.19 or newer
- Pi coding agent (tested with 0.84.2)
- `pi-web-access` (tested with 0.25.0)
- Access to the configured `openai-codex/gpt-5.6-luna`, `terra`, and `sol` models

## Install from a checkout

```bash
git clone https://github.com/MDGChamomile/pi-agent-kit.git
cd pi-agent-kit
pi install npm:pi-web-access
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills
ln -s "$PWD/live/extensions/pi-subagent" ~/.pi/agent/extensions/pi-subagent
ln -s "$PWD/live/skills/pi-subagent" ~/.pi/agent/skills/pi-subagent
```

Restart Pi or run `/reload` after installation.

## Contract

- Activation: the model may select the visible `pi-subagent` skill or `pi_subagent` tool when a task matches; users may still invoke `/skill:pi-subagent`
- Runs: one child call by default and up to three started calls per parent agent run for distinct, independent research tracks; sibling calls execute in parallel; one corrected retry is allowed only after preflight validation failure
- Child process: one ephemeral `pi --mode json --print --no-session` process per call
- Capabilities: `local` loads only Pi-owned `read`, `grep`, `find`, `ls`; `web` loads only web tools; `both` loads both sets; every mode also loads the guard-owned terminating `submit_subagent_report` tool
- Web tools: `web_search`, `source_check`, `fetch_content`, `get_search_content` from the package-declared entry point of the installed `pi-web-access` package
- Local scope: 0-8 existing files or directories inside the parent cwd; `local`/`both` require a non-empty scope and `web` requires an empty scope
- Web boundary: HTTP(S) under the installed web extension's SSRF protection policy; no local-file fetch, explicit browser-cookie auth, embedded URL credentials, or forced large GitHub clone; search curator is disabled
- Resources disabled: all discovered extensions, Skills, prompt templates, context files, themes, and project trust. Only the child guard and resolved web extension are explicitly loaded
- Readiness: the parent accepts a report only after the child guard validates policy and tool ownership and publishes a private readiness marker
- Return: each call must finish with exactly one successful guard-owned structured report, submitted as the only tool call in the final turn, containing a conclusion, up to 10 material findings, evidence locations, alternatives, uncertainties, and coverage gaps; the report tool enforces 8 KiB, a size-rejected submission may be reduced and retried, and the parent retains a 12 KiB final safety cap
- Progress: each running call reports its own `mm:ss · Subagent running · N reported tokens` status once per second
- Timeout: 20 minutes per call

Quality-tested presets combine child models and thinking levels without changing the main model's thinking:

- `lookup-standard` → Luna/low
- `lookup-balanced` → Luna/medium
- `lookup-deep` → Luna/high
- `analysis-standard` → Terra/high
- `analysis-deep` → Terra/xhigh
- `review-standard` → Sol/high
- `review-deep` → Sol/xhigh
- `review-exhaustive` → Sol/max

Older stored calls with separate `profile` and `thinking` arguments are translated by `prepareArguments()` to the nearest validated preset before schema validation.

The companion progressively disclosed workflow is `../../skills/pi-subagent/SKILL.md`.

## Security boundary

The child guard canonicalizes every requested local path and blocks paths outside the explicit scope, including lexical, absolute, and symlink escapes. It independently checks that each enabled local tool is Pi-owned and each enabled web tool comes from the package-declared entry point of the installed `pi-web-access` package. The web extension loads before the guard so the guard is the final `tool_call` policy handler. Local-only runs do not resolve or load the web extension. If policy or ownership validation fails, no readiness marker is published and the parent rejects any assistant text the child may still produce.

Web access is deliberately narrower than the full `pi-web-access` surface and remains subject to that extension's SSRF protection policy. The guard rejects local paths and `file:` URLs, explicit authenticated browser-cookie fetches, URL credentials, and forced oversized clones. The child prompt also forbids putting local file contents or secrets in web queries. The web extension may still make external provider requests and maintain its documented bounded cache or temporary files. Authorized local file contents, search queries, fetched public pages, and the final report are sent to the applicable model or search providers.

This is an application-level capability boundary, not an OS or network sandbox. The child and the trusted web extension still run as the current user. Do not use it for untrusted workloads requiring host isolation or for secrets that must not be sent to configured providers.

Ordinary child assistant text and investigation tool results are discarded. A zero-exit child without exactly one successful structured-report submission is rejected. Every error reaching the parent is control-character-sanitized and capped at 4 KiB; child failures also reserve space for content-free diagnostics such as the failure phase, exit and stop state, assistant completion mode, and report or tool-error counts. Tasks, paths, assistant text, and tool-result contents are never included in those diagnostics.

The extension does not support workspace writes, Bash, tests, session-history access, project-controlled resources, recursion, background runs, or child-session persistence. Parallelism is limited to three independent foreground child calls per parent agent run and can multiply model, provider, and web-request usage.

## Evaluation

`python3 live/extensions/pi-subagent/scripts/context_isolation_eval.py --mode context` runs matched direct-parent versus subagent cases without creating sessions. The final deterministic three-case run retained 100% fact recall in both arms while reducing mean maximum parent prompt tokens by 85.2% and parent investigative tool-result bytes by 100%; it produced no raw tool syntax or post-report parent investigation. Treat these figures as a bounded fixture result, not a universal production estimate.

`python3 live/extensions/pi-subagent/scripts/context_isolation_eval.py --mode quality` compares only presets belonging to each case profile. The initial lookup low/medium/high, analysis high/xhigh, and review high/xhigh/max runs all recovered every fixture fact with evidence and no raw tool syntax. The evaluator normalizes punctuation so terms such as `lost-update` and `lost update` score equivalently; `--include-reports` is an explicit diagnostic option for deterministic fixtures only.

## Verification

```bash
npm --prefix live/extensions/pi-subagent test
python3 live/extensions/pi-subagent/scripts/context_isolation_eval.py --mode smoke --capability local
python3 live/extensions/pi-subagent/scripts/context_isolation_eval.py --mode smoke --capability web
```

The web smoke test reproduces the normal loader arrangement: pi-web-access tools stay registered for provenance checks but are inactive in the parent model. It fails if the parent activates `load_web_tools` or calls a web tool directly.

The default test suite includes unit tests and deterministic spawned-child integration tests for structured-report isolation, missing reports, bounded provider errors, cancellation, timeout escalation, usage aggregation, scope, and tool ownership. Opt-in live smoke tests should additionally verify model-selected activation, three-call enforcement and parallel execution, fourth-call denial, an allowed local read, an out-of-scope denial, a public web search/fetch, local-file and auth-fetch denial, progress timer cleanup, and temporary-file cleanup.
