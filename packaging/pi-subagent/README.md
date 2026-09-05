# Pi Subagent

[![npm version](https://img.shields.io/npm/v/%40mdgchamomile%2Fpi-subagent)](https://www.npmjs.com/package/@mdgchamomile/pi-subagent)
[![npm downloads](https://img.shields.io/npm/dm/%40mdgchamomile%2Fpi-subagent)](https://www.npmjs.com/package/@mdgchamomile/pi-subagent)
[![License](https://img.shields.io/npm/l/%40mdgchamomile%2Fpi-subagent)](https://github.com/MDGChamomile/pi-agent-kit/blob/v0.2.5/LICENSE)

Run focused, bounded investigations in an ephemeral child Pi process while keeping intermediate tool output out of the parent context.

`@mdgchamomile/pi-subagent` bundles two parts that work together:

- **`pi_subagent` extension** — enforces scope, tool ownership, resource budgets, lifecycle, telemetry, and output boundaries.
- **Companion skill** — helps the parent decide when to delegate and selects the appropriate capability and model preset.

![Pi Subagent showing a completed child investigation and the context returned to the parent](https://raw.githubusercontent.com/MDGChamomile/pi-agent-kit/v0.2.5/live/extensions/pi-subagent/assets/pi-subagent-complete.png)

## Why use it?

Investigations can fill the main conversation with file reads, searches, fetched pages, and exploratory reasoning. Pi Subagent moves that work into a foreground child process and returns only its bounded final answer.

- **Keep context focused** — discard intermediate child turns and tool results while the parent handles decisions and final verification.
- **Limit access explicitly** — authorize 1–8 local paths or use a separate web-only capability; local and web tools never coexist in one child.
- **Bound execution** — cap runtime, tool calls, web requests, and final output while reporting progress and partial results visibly.
- **Load guidance only when needed** — progressively disclose the bundled skill instead of adding the full workflow to every prompt.

## Install

Requirements:

- Linux, including Ubuntu on WSL; native Windows is not officially supported or tested;
- Pi 0.84.2 or later;
- authentication for Pi's `openai-codex` provider and access to the selected child model listed under [Presets](#presets);
- `rg` for local `grep`, and `fd` or `fdfind` for local `find`.

> [!IMPORTANT]
> This package provides an application-level capability boundary, not an OS, network, or credential-isolated sandbox. Pi extensions execute with the current user's system permissions. Review the source and trust assumptions before installing it.

```bash
pi install npm:@mdgchamomile/pi-subagent
```

Restart Pi or run `/reload`. The model can select the skill automatically, or you can invoke it directly:

```text
/skill:pi-subagent
```

### Optional web capability

Local investigations work with this package alone. Web investigations require the exact reviewed `pi-web-access` version:

```bash
pi install npm:pi-web-access@v0.27.0
```

Without that dependency, local runs remain available.

## How it works

1. The parent delegates one focused task with a capability, explicit scope, and preset.
2. The parent extension canonicalizes the authorized scope and starts an ephemeral `pi --mode json --print --no-session` child process.
3. The child guard validates tool ownership, publishes a private readiness marker, and validates each local or web tool call before execution.
4. The child investigates within its time and resource budgets. The parent-side collector excludes intermediate messages and verifies readiness after the child exits before accepting its final answer.
5. The parent model context receives only the bounded final answer, prefixed with `[Subagent partial: REASON]` when a tool budget, investigation deadline, or model output limit leaves it incomplete. The marker is included within the output cap. Content-free execution and budget metadata remain in host-only tool-result details without tasks, paths, queries, URLs, or tool content.

[![Pi Subagent with parent-side collection and result assembly, an ephemeral child, separate local and web resource paths, and complete, partial, or error returns](https://raw.githubusercontent.com/MDGChamomile/pi-agent-kit/v0.2.5/live/extensions/pi-subagent/assets/pi-subagent-architecture.png)](https://github.com/MDGChamomile/pi-agent-kit/blob/v0.2.5/live/extensions/pi-subagent/assets/pi-subagent-architecture.png)

Collection, control-character sanitization, and result assembly run in the parent extension. Complete/partial calls return bounded answer text and separate host-only metadata; failures return bounded error text. Sanitization does not redact source quotations from the final answer. `--no-session` disables persisted Pi sessions, not in-memory context or private runtime files.

The child cannot write files, run Bash or tests, persist a session, or recursively launch more agents. Final validation and any implementation stay with the parent.

## Capabilities

| Capability | Available tools | Scope |
| --- | --- | --- |
| `local` | Pi-owned `read`, `grep`, `find`, and `ls` | 1–8 existing paths inside the parent working directory |
| `web` | Guarded tools from the pinned `pi-web-access` package | Empty; no local-file access |

Mixed local-and-web work uses separate child calls, with synthesis performed by the parent.

## Presets

| Preset | Provider/model ID | Thinking | Best for |
| --- | --- | --- | --- |
| `lookup-standard` | `openai-codex/gpt-5.6-luna` | `medium` | Bounded fact-finding |
| `analysis-standard` | `openai-codex/gpt-5.6-terra` | `medium` | Synthesis and causal comparison |
| `review-standard` | `openai-codex/gpt-5.6-sol` | `medium` | Adversarial review |

These mappings are fixed in the extension; they do not inherit the parent model or fall back to another provider. The preset does not alter the main model's thinking level. Installing this package does not grant model access: the selected model must be present in Pi's model registry and accessible to your authenticated account. If it is absent from the registry, the call fails during preflight with `Configured subagent model is unavailable`.

## Security and data flow

Authorized local-file contents, web tasks and queries, fetched pages, and the final answer may be sent to the applicable configured model or search providers. Do not delegate secrets that must not leave the host or use the package for untrusted workloads requiring host isolation.

The runtime canonicalizes local paths, blocks lexical and symlink escapes, verifies tool provenance, and sanitizes control characters in returned text. After the child exits, the parent verifies the guard's private readiness marker before accepting its final answer.

## Documentation

- [extension guide](https://github.com/MDGChamomile/pi-agent-kit/blob/v0.2.5/live/extensions/pi-subagent/README.md) — complete runtime, installation, security, and verification contract.
- [skill guide](https://github.com/MDGChamomile/pi-agent-kit/blob/v0.2.5/live/skills/pi-subagent/README.md) — when delegation is appropriate and how the workflow selects a child.
- [Source repository](https://github.com/MDGChamomile/pi-agent-kit)
- [Issue tracker](https://github.com/MDGChamomile/pi-agent-kit/issues)

## License

[MIT](https://github.com/MDGChamomile/pi-agent-kit/blob/v0.2.5/LICENSE)
