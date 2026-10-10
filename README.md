# Pi Subagent

![Pi Subagent by @MDGChamomile: a read-only subagent for Pi. Delegate the investigation. Keep the result.](extensions/pi-subagent/assets/pi-subagent-cover.png)

[![npm version](https://img.shields.io/npm/v/%40mdgchamomile%2Fpi-subagent)](https://www.npmjs.com/package/@mdgchamomile/pi-subagent)
[![npm downloads](https://img.shields.io/npm/dm/%40mdgchamomile%2Fpi-subagent)](https://www.npmjs.com/package/@mdgchamomile/pi-subagent)
[![License](https://img.shields.io/npm/l/%40mdgchamomile%2Fpi-subagent)](LICENSE)

Run focused, bounded investigations in an ephemeral child Pi process while keeping intermediate tool output out of the parent context.

`@mdgchamomile/pi-subagent` bundles two parts that work together:

- **`pi_subagent` extension** — enforces scope, tool ownership, resource budgets, lifecycle, telemetry, and output boundaries.
- **Companion skill** — guides the parent in deciding when to delegate and selecting the appropriate capability and model preset.

## See it in action

An illustrated CLI walkthrough of Pi Subagent's delegation workflow. The example uses a synthetic retry bug; dialogue, timing, and usage figures are illustrative rather than a recording of a live model session.

**Model invoked** — ask a normal question. When a focused investigation is appropriate, Pi can select the skill and delegate the investigation to a scoped, read-only child. You can also invoke `/skill:pi-subagent` explicitly with a focused task and scope; the parent follows the skill guidance and calls the same `pi_subagent` tool.

![Model-invoked investigation: a normal question leads Pi to delegate a scoped investigation, receive a bounded result, verify the decisive source lines, and answer](extensions/pi-subagent/assets/pi-subagent-automatic.gif)

## Why use it?

What fills an AI's context shapes its work. Investigations can fill the main conversation with file reads, searches, fetched pages, and exploratory reasoning. Pi Subagent moves that work into a foreground child process and returns only its bounded final answer.

- **Keep context focused** — discard intermediate child turns and tool results while the parent handles decisions and final verification.
- **Limit access explicitly** — authorize 1–8 local paths or use a separate web-only capability; local and web tools never coexist in one child.
- **Bound execution** — cap runtime, tool calls, web requests, and final output while reporting progress and partial results visibly.
- **Load guidance only when needed** — progressively disclose the bundled skill instead of adding the full workflow to every prompt.

## How it works

1. The parent chooses one focused task, a capability, an explicit scope, and a preset.
2. An ephemeral, read-only child Pi process investigates within runtime-enforced scope, tool, time, and output limits.
3. Intermediate child turns and tool results are discarded. The parent receives a bounded JSON envelope with runtime-owned status fields and the untrusted child `answer`; see the [result contract](extensions/pi-subagent/README.md#result-and-lifecycle).
4. The parent verifies decisive claims and performs any implementation or final validation itself.

[![Pi Subagent: the parent chooses a task, scope, capability, and preset; an ephemeral read-only subagent investigates either authorized local files or the web and returns at most 12 KiB of runtime-owned status fields and an untrusted answer, while intermediate tool output and child turns stay out of the parent context](extensions/pi-subagent/assets/pi-subagent-architecture.png)](extensions/pi-subagent/assets/pi-subagent-architecture.png)

The child cannot write files, run Bash or tests, persist a session, or recursively launch more agents. See the [extension guide](extensions/pi-subagent/README.md#how-it-works) for the process, guard, and readiness details.

## Install

Requirements:

- Linux, including Ubuntu on WSL, or macOS 15 on Apple Silicon (arm64); native Windows is not officially supported or tested;
- Pi 1.0.0 or later;
- authentication for the configured child provider and access to its model (`openai-codex` by default; see [Presets](#presets)).

macOS validation targets the Node.js Pi installation on macOS 15/arm64. Other macOS versions and Intel Macs are not covered by CI; no live provider compatibility is implied.

Capability-specific requirements:

- `local`: `rg` for `grep`, and `fd` or `fdfind` for `find`;
- `web`: `pi-web-access`; see [Optional web capability](#optional-web-capability).

> [!IMPORTANT]
> This package provides an application-level capability boundary, not an OS, network, or credential-isolated sandbox. Pi extensions execute with the current user's system permissions. Review the source and trust assumptions before installing it.

```bash
pi install npm:@mdgchamomile/pi-subagent
```

Restart Pi or run `/reload`.

### Optional web capability

Local investigations work with this package alone. Web investigations require `pi-web-access` v0.33.0 or later (stable releases) with its default tool names:

```bash
pi install npm:pi-web-access
```

Newer stable versions are allowed without an upper bound, not guaranteed compatible; upstream behavior changes may require maintenance. Package provenance checks, argument allowlists, and execution limits remain enforced. Without that dependency, local runs remain available.

### First investigation

Before your first call, run `/pi-subagent-settings` in Pi's TUI to check the model for each preset you plan to use. If you cannot access a default model, select one you can access. Subagents do not inherit the parent model, and there is no automatic fallback. See [Presets](#presets) for details.

If a call fails with a generic exit-code error, check the selected preset's provider authentication, model access, and settings. Use the provider's supported Pi authentication method (`/login` where supported, or its documented API-key setup), or select another authenticated, accessible model with `/pi-subagent-settings`. The exit code alone does not establish an authentication failure.

The model can select the skill automatically. To invoke it explicitly, include a focused task and scope. For example, from a project with a `src/` directory:

```text
/skill:pi-subagent Investigate how cancellation terminates child processes within src/. Return conclusions with file and line evidence.
```

This command gives delegation guidance to the parent, which then calls the `pi_subagent` tool.

## Capabilities

| Capability | Available tools | Scope |
| --- | --- | --- |
| `local` | Pi-owned `read`, `grep`, `find`, and `ls` | 1–8 existing paths inside the parent working directory |
| `web` | Guarded tools from `pi-web-access` v0.33.0 or later (stable releases) | Empty; no local-file access |

Mixed local-and-web work uses separate child calls, with synthesis performed by the parent. One call is the default; each parent agent run allows at most three started child calls in total, whether sequential or parallel. Distinct, independent calls can run in parallel, and local and web calls share the same limit. One corrected retry is allowed after a preflight validation failure; it does not permit a fourth started call. Multiple calls can multiply model, provider, and web-request usage.

## Presets

| Preset | Provider/model ID | Thinking | Best for |
| --- | --- | --- | --- |
| `lookup-standard` | `openai-codex/gpt-6-luna` | `medium` | Bounded fact-finding |
| `analysis-standard` | `openai-codex/gpt-6.1-sol` | `medium` | Synthesis and causal comparison |
| `review-standard` | `openai-codex/gpt-6.1-sol` | `high` | Adversarial review |

These are **default settings**, not required providers or models. They do not inherit the parent model or change its thinking level.

Run **`/pi-subagent-settings`** in Pi's TUI to change a preset's provider, model, or thinking level, or edit `~/.pi/agent/pi-subagent.json` (under `PI_CODING_AGENT_DIR` when set). Settings apply to the next call without a reload. OpenAI access is not required when you configure other providers available through Pi. Change each preset you intend to use; untouched presets retain their Codex defaults. Only user-level settings are read; project files and tool arguments cannot override them, and there is no automatic fallback. Authenticate each provider through Pi. See the [extension guide](extensions/pi-subagent/README.md#presets) for the settings file format and validation rules.

## Security and data flow

The delegated task, scope path names, local tool results (file contents, matched lines, and file/directory listings), and retrieved web content enter the configured child model provider's context. Web queries and requested URLs also go to the applicable search/fetch services. The final answer returns to the parent and enters its model context. Do not delegate secrets that must not leave the host or use the package for untrusted workloads requiring host isolation.

The runtime canonicalizes local paths, blocks lexical and symlink escapes, verifies tool provenance, and sanitizes control characters in returned text. After the child exits, the parent verifies the guard's private readiness marker before accepting its final answer.

## Documentation

- [Extension guide](extensions/pi-subagent/README.md) — complete runtime, installation, security, and verification contract.
- [Skill guide](skills/pi-subagent/README.md) — when delegation is appropriate and how the workflow selects a child.
- [Source repository](https://github.com/MDGChamomile/pi-subagent)
- [Issue tracker](https://github.com/MDGChamomile/pi-subagent/issues)
- [Contributing](CONTRIBUTING.md) — development setup and offline verification.
- [Package maintenance](packaging/pi-subagent/DEVELOPMENT.md) — package assembly and release procedures.
- [Migration](MIGRATION.md) — release notes and migration steps.
- [Design principles](PRINCIPLE.md) — local pointer to the [canonical principles](https://github.com/MDGChamomile/MDGChamomile/blob/main/PRINCIPLE.md).

## License

[MIT](LICENSE)
