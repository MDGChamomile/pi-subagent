# Pi Subagent Skill

A progressively disclosed workflow for deciding when and how Pi should delegate a focused investigation to the companion `pi_subagent` extension tool.

The skill keeps noisy file reads or web searches out of the parent context. The child is read-only, returns only a bounded final answer, and leaves implementation and final validation with the parent.

See the extension guide for the [architecture overview](../../extensions/pi-subagent/README.md#how-it-works), [runtime screenshots](../../extensions/pi-subagent/README.md#in-action), and complete execution contract.

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
2. The workflow selects `local` or `web`, an explicit scope, and the least capable standard preset.
3. The companion extension starts one ephemeral, read-only child Pi process. Local and web access never coexist in the same child.
4. Intermediate child turns and tool results stay outside the parent context; only the final bounded answer returns.
5. A lifetime tool budget gives one soft warning, then returns the best available answer as `partial` if a hard tool-call or web query/fetch limit is reached. Partial results include a `[Subagent partial: REASON]` prefix in the returned text: `tool_budget`, `time_limit`, or `model_length` identifies an exhausted budget, investigation deadline, or model output limit. The parent reads this marker rather than host-only tool-result details.
6. The parent verifies decisive claims and performs any implementation or final validation itself.

The three presets are:

| Preset | Child profile | Use for |
| --- | --- | --- |
| `lookup-standard` | Luna / medium | Bounded fact-finding |
| `analysis-standard` | Terra / medium | Synthesis and causal comparison |
| `review-standard` | Sol / medium | Adversarial review |

## Requirements and installation

This skill requires the companion global extension, Pi 0.84.2 or later, and authentication for Pi's `openai-codex` provider with access to the selected child model. The extension's [preset table](../../extensions/pi-subagent/README.md#presets) lists the exact, fixed provider/model IDs behind Luna, Terra, and Sol; they do not inherit the parent model. Web investigations also require the tested `pi-web-access` v0.27.0 with its default tool names.

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
