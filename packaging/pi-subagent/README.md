# Pi Subagent

Run focused, bounded investigations in an ephemeral child Pi process while keeping intermediate tool output out of the parent context.

`@mdgchamomile/pi-subagent` bundles two parts that work together:

- **`pi_subagent` extension** — enforces scope, tool ownership, resource budgets, lifecycle, telemetry, and output boundaries.
- **Companion skill** — helps the parent decide when to delegate and selects the appropriate capability and model preset.

![Pi Subagent showing a completed child investigation and the context returned to the parent](https://raw.githubusercontent.com/MDGChamomile/pi-agent-kit/main/live/extensions/pi-subagent/assets/pi-subagent-complete.png)

## Why use it?

Investigations can fill the main conversation with file reads, searches, fetched pages, and exploratory reasoning. Pi Subagent moves that work into a foreground child process and returns only its bounded final answer.

Use it for:

- targeted fact-finding across an explicit set of local files;
- focused public-web research without exposing local-file tools to the child;
- synthesis or adversarial review that would otherwise add substantial intermediate context;
- keeping the parent focused on implementation, decisions, and final verification.

## Highlights

- **Context isolation** — intermediate child turns and tool results are discarded.
- **Explicit read-only scope** — local runs receive only 1–8 authorized files or directories.
- **Separated capabilities** — local-file and web tools never coexist in one child.
- **Bounded execution** — limits apply to runtime, tool calls, web queries, fetched targets, and final output size.
- **Visible progress** — the Pi TUI reports elapsed time, model, thinking level, token usage, completion status, and estimated injected context.
- **Defensive lifecycle handling** — includes cancellation, timeout escalation, partial-result reporting, and parent-liveness cleanup.
- **Progressive disclosure** — the bundled skill is loaded when relevant rather than adding the full workflow to every prompt.

## Install

Pi **0.84.2 or later** is required.

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
pi install npm:pi-web-access@v0.26.0
```

Without that dependency, local runs remain available.

## How it works

1. The parent delegates one focused task with a capability, explicit scope, and preset.
2. The extension starts an ephemeral `pi --mode json --print --no-session` child process.
3. A child guard validates tool ownership and applies the local or web boundary.
4. The child investigates within its time and resource budgets.
5. The parent receives only the final bounded answer and numeric/boolean budget telemetry.

The child cannot write files, run Bash or tests, persist a session, or recursively launch more agents. Final validation and any implementation stay with the parent.

## Capabilities

| Capability | Available tools | Scope |
| --- | --- | --- |
| `local` | Pi-owned `read`, `grep`, `find`, and `ls` | 1–8 existing paths inside the parent working directory |
| `web` | Guarded tools from the pinned `pi-web-access` package | Empty; no local-file access |

Mixed local-and-web work uses separate child calls, with synthesis performed by the parent.

## Presets

| Preset | Child profile | Best for |
| --- | --- | --- |
| `lookup-standard` | Luna / medium | Bounded fact-finding |
| `analysis-standard` | Terra / medium | Synthesis and causal comparison |
| `review-standard` | Sol / medium | Adversarial review |

The preset changes only the child model; it does not alter the main model's thinking level.

## Requirements

- Pi 0.84.2 or later;
- access to the child model selected by the Luna, Terra, or Sol preset;
- `rg` for local `grep`;
- `fd` or `fdfind` for local `find`;
- `pi-web-access` v0.26.0 only when using the web capability.

## Security and data flow

> [!IMPORTANT]
> This package provides an application-level capability boundary, not an OS, network, or credential-isolated sandbox. Pi extensions execute with the current user's system permissions. Review the source and trust assumptions before installing third-party packages.

Authorized local-file contents, web tasks and queries, fetched pages, and the final answer may be sent to the applicable configured model or search providers. Do not delegate secrets that must not leave the host or use the package for untrusted workloads requiring host isolation.

The runtime canonicalizes local paths, blocks lexical and symlink escapes, verifies tool provenance, sanitizes returned text, and rejects child answers produced before the guard publishes its readiness marker.

## Documentation

- [Extension guide](extensions/pi-subagent/README.md) — complete runtime, installation, security, and verification contract.
- [Skill guide](skills/pi-subagent/README.md) — when delegation is appropriate and how the workflow selects a child.
- [Source repository](https://github.com/MDGChamomile/pi-agent-kit)
- [Issue tracker](https://github.com/MDGChamomile/pi-agent-kit/issues)

## License

[MIT](LICENSE)
