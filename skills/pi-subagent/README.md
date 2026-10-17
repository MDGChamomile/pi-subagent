# Pi Subagent Skill

A progressively disclosed workflow for deciding when and how Pi should delegate a focused investigation to the companion `pi_subagent` extension tool.

The skill keeps noisy file reads or web searches out of the parent context. The child is read-only, returns only a bounded final answer, and leaves implementation and final validation with the parent.

Start with the README's [first-use example](../../README.md#first-investigation) and [illustrated walkthrough](../../README.md#see-it-in-action). See the extension guide for the [architecture overview](../../extensions/pi-subagent/README.md#how-it-works) and complete execution contract.

## When to use it

Use the skill for a focused, one-shot investigation when the parent needs conclusions and evidence locations, but not the intermediate reads or searches.

Good fits include:

- locating the source of a behavior across several files;
- comparing a small number of public sources;
- reviewing a bounded area for material risks;
- splitting up to three independent research tracks that benefit from parallel work.

Keep the work in the parent for simple lookups, implementation, commands, tests, or post-edit validation that may lead to follow-up fixes.

## How it works

The model may load [`SKILL.md`](SKILL.md) when the task matches, or the user can invoke `/skill:pi-subagent` to load it explicitly. See the README's [workflow overview](../../README.md#how-it-works) and configurable [default presets](../../README.md#presets), plus the extension's [result contract](../../extensions/pi-subagent/README.md#result-and-lifecycle).

## Requirements and installation

Follow the README's [requirements and installation guide](../../README.md#install) to install the companion extension and skill together.

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
