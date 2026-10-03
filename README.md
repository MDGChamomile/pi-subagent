# Pi Subagent

[![npm version](https://img.shields.io/npm/v/%40mdgchamomile%2Fpi-subagent)](https://www.npmjs.com/package/@mdgchamomile/pi-subagent)
[![npm downloads](https://img.shields.io/npm/dm/%40mdgchamomile%2Fpi-subagent)](https://www.npmjs.com/package/@mdgchamomile/pi-subagent)
[![License](https://img.shields.io/npm/l/%40mdgchamomile%2Fpi-subagent)](LICENSE)

Run focused, bounded investigations in an ephemeral child Pi process while keeping intermediate tool output out of the parent context.

`@mdgchamomile/pi-subagent` bundles two parts that work together:

- **`pi_subagent` extension** — enforces scope, tool ownership, resource budgets, lifecycle, telemetry, and output boundaries.
- **Companion skill** — guides the parent in deciding when to delegate and selecting the appropriate capability and model preset.

### See it in action

An illustrated CLI walkthrough of Pi Subagent's delegation workflow. The example uses a synthetic retry bug; dialogue, timing, and usage figures are illustrative rather than a recording of a live model session.

**Model invoked** — ask a normal question. When a focused investigation is appropriate, Pi can select the skill and delegate the investigation to a scoped, read-only child. You can also invoke `/skill:pi-subagent` explicitly with a focused task and scope; the parent follows the skill guidance and calls the same `pi_subagent` tool.

![Model-invoked investigation: a normal question leads Pi to delegate a scoped investigation, receive a bounded result, verify the decisive source lines, and answer](extensions/pi-subagent/assets/pi-subagent-automatic.gif)

In either case, intermediate child reads stay out of the parent context. The child investigates only; implementation, tests, and final verification remain with the parent.

## Why use it?

Investigations can fill the main conversation with file reads, searches, fetched pages, and exploratory reasoning. Pi Subagent moves that work into a foreground child process and returns only its bounded final answer.

- **Keep context focused** — discard intermediate child turns and tool results while the parent handles decisions and final verification.
- **Limit access explicitly** — authorize 1–8 local paths or use a separate web-only capability; local and web tools never coexist in one child.
- **Bound execution** — cap runtime, tool calls, web requests, and final output while reporting progress and partial results visibly.
- **Load guidance only when needed** — progressively disclose the bundled skill instead of adding the full workflow to every prompt.

## Install

Requirements:

- Linux, including Ubuntu on WSL; native Windows is not officially supported or tested;
- Pi 0.99.1 or later;
- authentication for the configured child provider and access to its model (`openai-codex` by default; see [Presets](#presets));
- `rg` for local `grep`, and `fd` or `fdfind` for local `find`.

> [!IMPORTANT]
> This package provides an application-level capability boundary, not an OS, network, or credential-isolated sandbox. Pi extensions execute with the current user's system permissions. Review the source and trust assumptions before installing it.

```bash
pi install npm:@mdgchamomile/pi-subagent
```

Restart Pi or run `/reload`.

Before your first call, run `/pi-subagent-settings` in Pi's TUI to check the model for each preset you plan to use. If you cannot access a default model, select one you can access. Subagents do not inherit the parent model, and there is no automatic fallback. See [Presets](#presets) for details.

The model can select the skill automatically. To invoke it explicitly, include a focused task and scope. For example, from a project with a `src/` directory:

```text
/skill:pi-subagent Investigate how cancellation terminates child processes within src/. Return conclusions with file and line evidence.
```

This command gives delegation guidance to the parent, which then calls the `pi_subagent` tool. The child investigates only: it does not modify files or run tests, and final verification remains with the parent.

### Optional web capability

Local investigations work with this package alone. Web investigations require `pi-web-access` v0.33.0 or later (stable releases) with its default tool names:

```bash
pi install npm:pi-web-access
```

Newer stable versions are allowed without an upper bound, not guaranteed compatible; upstream behavior changes may require maintenance. Package provenance checks, argument allowlists, and execution limits remain enforced. Without that dependency, local runs remain available.

## How it works

1. The parent delegates one focused task with a capability, explicit scope, and preset.
2. The parent extension canonicalizes the authorized scope and starts an ephemeral `pi --mode json --print --no-session` child process.
3. The child guard validates tool ownership, publishes a private readiness marker, and validates each local or web tool call before execution.
4. The child investigates within its time and resource budgets. The parent-side collector excludes intermediate messages and verifies readiness after the child exits before accepting its final answer.
5. The parent model context receives a bounded JSON envelope with runtime-owned status fields and the untrusted child `answer`; see the [result contract](extensions/pi-subagent/README.md#result-and-lifecycle).

[![Parent Pi delegates a scoped task to a read-only subagent, which investigates local files or the web and returns a bounded result while intermediate reads stay out of the parent context](extensions/pi-subagent/assets/pi-subagent-architecture.png)](extensions/pi-subagent/assets/pi-subagent-architecture.png)

The child cannot write files, run Bash or tests, persist a session, or recursively launch more agents. Final validation and any implementation stay with the parent.

## Capabilities

| Capability | Available tools | Scope |
| --- | --- | --- |
| `local` | Pi-owned `read`, `grep`, `find`, and `ls` | 1–8 existing paths inside the parent working directory |
| `web` | Guarded tools from `pi-web-access` v0.33.0 or later (stable releases) | Empty; no local-file access |

Mixed local-and-web work uses separate child calls, with synthesis performed by the parent.

## Presets

| Preset | Provider/model ID | Thinking | Best for |
| --- | --- | --- | --- |
| `lookup-standard` | `openai-codex/gpt-6-luna` | `medium` | Bounded fact-finding |
| `analysis-standard` | `openai-codex/gpt-6.1-sol` | `medium` | Synthesis and causal comparison |
| `review-standard` | `openai-codex/gpt-6.1-sol` | `high` | Adversarial review |

These are **default settings**, not required providers or models. They do not inherit the parent model or change its thinking level.

Run **`/pi-subagent-settings`** in Pi's TUI to change a preset's provider, model, or thinking level, or edit `~/.pi/agent/pi-subagent.json` (under `PI_CODING_AGENT_DIR` when set). Settings apply to the next call without a reload. Only user-level settings are read; project files and tool arguments cannot override them, and there is no automatic fallback. Authenticate each provider through Pi. See the [extension guide](extensions/pi-subagent/README.md#presets) for the settings file format and validation rules.

## Security and data flow

Authorized local-file contents, web tasks and queries, fetched pages, and the final answer may be sent to the applicable configured model or search providers. Do not delegate secrets that must not leave the host or use the package for untrusted workloads requiring host isolation.

The runtime canonicalizes local paths, blocks lexical and symlink escapes, verifies tool provenance, and sanitizes control characters in returned text. After the child exits, the parent verifies the guard's private readiness marker before accepting its final answer.

## Documentation

- [extension guide](extensions/pi-subagent/README.md) — complete runtime, installation, security, and verification contract.
- [skill guide](skills/pi-subagent/README.md) — when delegation is appropriate and how the workflow selects a child.
- [Source repository](https://github.com/MDGChamomile/pi-subagent)
- [Issue tracker](https://github.com/MDGChamomile/pi-subagent/issues)
- [Contributing](CONTRIBUTING.md) — development setup and offline verification.
- [Package maintenance](packaging/pi-subagent/DEVELOPMENT.md) — package assembly and release procedures.
- [Migration](MIGRATION.md) — existing npm and source installations.
- [Design principles](PRINCIPLE.md) — local pointer to the [canonical principles](https://github.com/MDGChamomile/MDGChamomile/blob/main/PRINCIPLE.md).

## License

[MIT](LICENSE)
