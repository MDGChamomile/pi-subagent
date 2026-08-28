# Pi Subagent

A foreground, model-invocable Pi extension that runs focused local-file or public-web investigations outside the parent context.

The companion [skill](../../skills/pi-subagent/README.md) decides when and how to delegate. This extension enforces the runtime boundary, launches the child, reports progress, and returns only the bounded final answer.

## In action

These screenshots show a real local lookup against this repository. Machine-specific paths and account details were removed from the rendered output.

**Running — elapsed time, child model, thinking level, and reported tokens**

![Pi Subagent reporting elapsed time, child model, thinking level, and reported tokens while running](assets/pi-subagent-running.png)

**Complete — completion time, injected context size, and expanded final answer**

![Pi Subagent reporting completion time, injected context size, and the expanded final answer](assets/pi-subagent-complete.png)

## Requirements and installation

Requirements:

- Pi 0.84.2 or later;
- access to the configured Luna, Terra, and Sol child models;
- `rg` for local `grep`, and `fd` or `fdfind` for local `find`;
- `pi-web-access` with its default tool names for public-web investigations.

Install both the extension and its companion skill from a checkout:

```bash
git clone https://github.com/MDGChamomile/pi-agent-kit.git
cd pi-agent-kit
pi install npm:pi-web-access
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills
ln -s "$PWD/live/extensions/pi-subagent" ~/.pi/agent/extensions/pi-subagent
ln -s "$PWD/live/skills/pi-subagent" ~/.pi/agent/skills/pi-subagent
```

Restart Pi or run `/reload`. The model can then select the skill automatically, or the user can invoke `/skill:pi-subagent`.

> [!NOTE]
> `pi-web-access` is only needed for `web` runs. Local child startup is forced offline and never downloads missing search binaries.

## How it works

1. The parent calls `pi_subagent` with one focused task, a capability, an explicit scope, and a preset.
2. The extension starts one ephemeral `pi --mode json --print --no-session` child process.
3. A child guard validates tool ownership and applies the local or web boundary before publishing a private readiness marker.
4. The parent discards intermediate child turns and tool results, then retains only the last valid non-tool assistant answer.
5. The TUI reports per-call progress and, when settled, the elapsed time and estimated context injected into the parent.

One child call is the default. Up to three distinct, independent calls may run in parallel during one parent agent run; local and web calls each count toward that limit and can multiply model, provider, and web-request usage. One corrected retry is allowed only after preflight validation fails.

## Runtime contract

### Capabilities and scope

- `local` loads only Pi-owned `read`, `grep`, `find`, and `ls`. It requires 1-8 existing files or directories inside the parent working directory.
- `web` loads only `web_search`, `source_check`, `fetch_content`, and `get_search_content` from the installed `pi-web-access` package. Its scope must be empty.
- Local and web access never coexist in one child. Mixed-source work uses separate calls and parent-side synthesis.
- A bare `@` is rejected rather than expanding to the parent working directory.
- The child cannot write files, run Bash or tests, inspect sessions, recurse, run in the background, persist a child session, or load discovered extensions, Skills, prompt templates, context files, themes, or project trust.

### Presets

Each standard preset chooses a proportionate child model without changing the main model's thinking level:

| Preset | Child profile | Use for |
| --- | --- | --- |
| `lookup-standard` | Luna / low | Bounded fact-finding |
| `analysis-standard` | Terra / medium | Synthesis and causal comparison |
| `review-standard` | Sol / medium | Adversarial review |

Older stored calls with separate `profile` and `thinking` arguments, or with the former balanced/deep/exhaustive preset names, are translated to the matching standard preset before schema validation.

### Result and lifecycle

- The parent accepts a final answer only after the child guard validates policy and tool ownership and publishes its readiness marker.
- Intermediate assistant turns and investigation tool results are discarded. The collector retains only the last assistant message containing non-empty text without a tool call or terminal model error, sanitizes it, and caps it at 12 KiB.
- A tool-only ending gets one tool-disabled finalization follow-up. A zero-exit child that still has no final answer is rejected.
- Each running call reports `mm:ss · model (thinking) running · N reported tokens` once per second.
- A settled row reports `✓ Complete · 14.2s · Context injected: ~1,820 tokens`, or `⚠ Partial`; expanding it reveals the answer.
- The investigation deadline is 18 minutes. The child then gets a two-minute text-finalization window within the 20-minute hard limit. Answers completed in that window are labelled `partial`; an unresponsive child is terminated at the hard deadline.
- A dedicated parent-liveness pipe makes the child remove private runtime files and terminate its POSIX process group, or the child process itself on Windows, if the parent exits abruptly.
- Final diff, audit, test, and retrieval validation stays with the parent when it holds the edited files or may need to make follow-up fixes.

## Security boundary

### Local runs

The child guard canonicalizes every requested path, replaces the tool input with that authorized canonical path, and blocks paths outside the explicit scope, including lexical, absolute, and symlink escapes. It independently verifies that every enabled local tool is Pi-owned. Local runs do not resolve or load the web extension.

### Web runs

The web extension loads before the guard, making the guard the final `tool_call` policy handler. Every web tool uses a pinned, default-deny argument allowlist:

- searches are non-interactive, use the configured provider, disable curation and background content expansion, and allow at most four queries with ten results each;
- fetches allow at most five readable HTTP(S) URLs under the web extension's SSRF policy;
- caller-selected providers or proxies, local files, browser-cookie authentication, answer/model/media modes, embedded URL credentials, and forced GitHub clones are rejected.

A denied input blocks only that call, allowing the child to correct it. Every corrected call is validated independently.

### Trust model and data flow

If policy or ownership validation fails, no readiness marker is published and the parent rejects any assistant text the child may still produce. Errors returned to the parent are control-character-sanitized and capped at 4 KiB; failure diagnostics omit tasks, paths, assistant text, and tool-result contents. Child stderr is discarded, while reported child usage is attached to the parent tool result on success and failure.

Authorized local file contents, web tasks and queries, fetched public pages, and the final answer are sent to the applicable model or search providers. The trusted web extension may maintain its documented bounded cache or temporary files.

This is an application-level capability boundary, not an OS or network sandbox. The child and trusted web extension still run as the current user. Do not use it for untrusted workloads requiring host isolation or for secrets that must not be sent to configured providers.

## Evaluation

From the repository root, run:

```bash
python3 live/extensions/pi-subagent/scripts/context_isolation_eval.py --mode context
```

The first plain-final-answer three-case run retained 100% fact recall in both arms while reducing mean maximum parent prompt tokens by 89.2% and parent investigative tool-result bytes by 100%. It produced no raw tool syntax or post-result parent investigation. Treat these deterministic fixture results as bounded checks, not universal production estimates.

## Verification

```bash
npm --prefix live/extensions/pi-subagent test
python3 live/extensions/pi-subagent/scripts/context_isolation_eval.py --mode smoke --capability local
python3 live/extensions/pi-subagent/scripts/context_isolation_eval.py --mode smoke --capability web
```

The web smoke test reproduces the normal loader arrangement: `pi-web-access` tools stay registered for provenance checks but remain inactive in the parent model. It fails if the parent activates `load_web_tools` or calls a web tool directly.

The default suite covers final-answer isolation, complete and partial outcomes, tool-disabled finalization, empty answers, bounded provider errors, cancellation, timeout escalation, abrupt parent exit, usage aggregation, scope, recoverable web denials, and tool ownership. Opt-in smoke tests additionally cover live model selection and the local/web runtime boundaries.
