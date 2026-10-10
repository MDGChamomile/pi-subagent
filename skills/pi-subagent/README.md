# Pi Subagent Skill

A progressively disclosed workflow for deciding when and how Pi should delegate a focused investigation to the companion `pi_subagent` extension tool.

The skill keeps noisy file reads or web searches out of the parent context. The child is read-only, returns only a bounded final answer, and leaves implementation and final validation with the parent.

See the extension guide for the [first-use example](../../extensions/pi-subagent/README.md#first-investigation), [architecture overview](../../extensions/pi-subagent/README.md#how-it-works), [runtime demo](../../extensions/pi-subagent/README.md#in-action), and complete execution contract.

## When to use it

Use the skill for a focused, one-shot investigation when the parent needs conclusions and evidence locations, but not the intermediate reads or searches.

Good fits include:

- locating the source of a behavior across several files;
- comparing a small number of public sources;
- reviewing a bounded area for material risks;
- splitting up to three independent research tracks that benefit from parallel work.

Keep the work in the parent for simple lookups, implementation, commands, tests, or post-edit validation that may lead to follow-up fixes.

## How it works

1. The model may load [`SKILL.md`](SKILL.md) when the task matches, or the user can invoke `/skill:pi-subagent` to load it explicitly.
2. The parent selects `local` or `web`, an explicit scope, and the standard preset appropriate to the task.
3. The companion extension starts one ephemeral, read-only child Pi process. Local and web access never coexist in the same child.
4. Intermediate child turns and tool results stay outside the parent context; only the final bounded answer returns.
5. Runtime budgets bound each child. The parent receives a bounded JSON envelope whose runtime-owned fields report a complete or partial result; see the [result contract](../../extensions/pi-subagent/README.md#result-and-lifecycle).
6. The parent verifies decisive claims and performs any implementation or final validation itself.

The parent selects one of three standard presets; see the [default settings](../../README.md#presets), which users can override.

## Requirements and installation

This skill requires the companion extension, Pi 1.0.0 or later, and authentication for the configured child provider with access to the selected model. The extension's [preset settings](../../extensions/pi-subagent/README.md#presets) describe the defaults and user overrides, including Anthropic and OpenRouter. They do not inherit the parent model. Web investigations also require `pi-web-access` v0.33.0 or later (stable releases) with its default tool names. Newer versions are allowed without an upper bound, not guaranteed compatible; upstream behavior changes may require extension maintenance.

Follow the extension's [requirements and installation guide](../../extensions/pi-subagent/README.md#requirements-and-installation) to install both components together.

> [!IMPORTANT]
> This README is the human-facing overview. Pi loads [`SKILL.md`](SKILL.md) as the executable workflow; keep that file alongside this README when copying or linking the skill.

## Security summary

- The child cannot write files, run Bash, inspect sessions, or load project-controlled resources.
- Local runs are restricted to explicitly scoped paths inside the parent working directory.
- Web runs have no local-file tools and apply default-deny argument allowlists.
- The `web` capability is not a credential-isolated sandbox; the trusted web extension may use host credentials and reach authenticated target sources.
- Delegated content and the final answer reach the selected model provider; web queries and pages may also reach search providers.
- This is an application-level capability boundary, not an OS sandbox.

For the complete runtime contract, threat model, evaluation, and verification commands, see the [extension guide](../../extensions/pi-subagent/README.md).
