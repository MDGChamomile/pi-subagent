# 12-task production-preset exploratory pilot

Status: **exploratory calibration, not confirmatory evidence**.

## Design

This pilot compared direct parent investigation (A) with delegation through the checked-in production preset (B).

- 12 frozen local tasks: 4 lookup, 4 analysis, and 4 review;
- 8 clean implementation tasks and 4 review tasks with frozen injected defects;
- 3 repetitions per task and arm: 72 fresh parent runs and 36 child runs;
- balanced block order: 18 AB and 18 BA blocks;
- parent in both arms: `openai-codex/gpt-5.6-sol`, high thinking;
- production children: Luna/medium for lookup, Terra/medium for analysis, and Sol/medium for review;
- frozen snapshots, prompts, schedule, and hashes; no web or repository writes;
- the earlier manual scope-containment task and the old three deterministic fixtures were excluded.

All 72 parent runs exited successfully and returned a final answer. Every B run made exactly one successful child call; all 36 children completed. A separate post-run configuration validator checked the recorded preset, model, and thinking level for every delegated run: each profile matched its declared production mapping in all 12 runs. One B parent performed one local verification read after delegation.

## Context and resource results

Continuous metrics were reduced to the median of three repetitions within each task and arm before task-level comparisons.

| Outcome | Result |
| --- | ---: |
| Median task-level parent cumulative-prompt reduction | **93.9%** |
| Stratified task bootstrap 95% interval | **92.0% to 95.0%** |
| Corpus-wide parent cumulative-prompt reduction | **94.1%** |
| Median run parent peak-prompt reduction | **86.4%** |
| Parent investigative tool-result bytes | 2,185,232 (A) vs 105,766 (B), **95.2% lower** |
| Parent tool calls | 614 (A) vs 37 (B) |
| Parent-plus-child reported tokens | 2,327,171 (A) vs 2,170,636 (B), **6.7% lower** |
| Reported provider cost | 8.738 (A) vs 4.500 (B), **48.5% lower** |
| Median wall time | 70.4 s (A) vs 73.8 s (B), **4.9% slower** |

The production-configuration trade-off varied materially by profile. Delegation used 29% more combined reported tokens for lookup, 37% fewer for analysis, and 7% more for review. It cost less for lookup and analysis because those presets use smaller models, but review delegation used about 7% more reported cost and was materially slower. Parent-context savings were large in every profile.

## Provisional quality result

A frozen lexical claim/citation scorer gave median task scores of 91.4 for A and 87.6 for B. The paired mean difference was **-4.76 points (B − A)** with an exploratory stratified bootstrap interval of **-8.81 to -0.68**. This does **not** establish quality non-inferiority under a -3 point margin.

The quality endpoint is provisional. The scorer checks frozen technical terms and evidence-line overlap but does not judge causal logic or unsupported claims. It is sensitive to harmless formatting differences: for example, one otherwise cited answer used Markdown backticks around every citation, which the strict citation parser did not recognize. The scorer was frozen after the first orchestration-preflight output had been inspected. No independent blinded judge or human audit was performed.

Accordingly, this pilot supports a bounded claim that production delegation substantially reduced **parent context** on these tasks. It does not support a universal total-token, latency, cost, or quality-preservation claim.

## Artifacts

- `protocol.json`, `tasks.json`, and `schedule.json`: frozen design and task order;
- `FROZEN_SHA256`, `PROMPT_SHA256SUMS`, and `COMMAND_SHA256SUMS`: pre-run hashes;
- `run-template.sh`: portable form of the exact parent invocation;
- `score_pilot.py` and `SCORING_FREEZE.json`: deterministic normalization/scoring and its disclosure;
- `validate_configuration.py` and `CONFIGURATION_VALIDATION.json`: post-run verification of every arm and child preset/model/thinking assignment;
- `summary.json` and `scores.jsonl`: machine-readable results;
- `PUBLIC_SHA256SUMS`: hashes for the publishable pilot bundle;
- local ignored `commands/`, `raw/`, `normalized/`, `logs/`, and `snapshots/`: machine-specific commands, raw events, run records, process metadata, and frozen source snapshots. The ignored local `SHA256SUMS` covers that complete archive.

The pilot is calibration material only and must not enter a future confirmatory corpus.
