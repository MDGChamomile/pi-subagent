# Pi Subagent Context-Isolation Benchmark v2

Status: **confirmatory design only; not executable yet**. No confirmatory corpus has been selected and no benchmark or judge model calls are authorized by this document. A separate [12-task exploratory production-preset pilot](pilots/2026-09-01-production-12-task/REPORT.md) is archived below; it is calibration material and does not execute or validate this confirmatory protocol.

This benchmark estimates context, quality, cost, and latency effects without targeting or attempting to reproduce the earlier 85.2% calibration result. The old three-fixture evaluator and the future 12-task calibration set are excluded from the confirmatory results.

## 1. Claims this benchmark may support

The benchmark has two predeclared estimands:

1. **Matched-model delegation effect (primary):** direct parent investigation versus bounded delegation when parent and child use the same model and thinking level.
2. **Production-configuration effect (secondary):** direct parent investigation versus the checked-in Luna/Terra/Sol production presets.

The first estimand is not described as a pure context-isolation effect. Delegation also changes the child system prompt, tool budget, and execution topology. Those differences are inherent to the evaluated extension and must remain visible in the report.

Results apply to the frozen corpus and its declared strata. They are not universal production estimates.

## 2. Arms

All arms use the same parent model, parent thinking level, objective, answer format, local snapshot, timeout, and parent local-tool set. Delegated arms additionally enable `pi_subagent`. The parent always produces the user-facing final answer that is scored.

| Arm | Parent | Investigation |
|---|---|---|
| `direct` (A) | `openai-codex/gpt-5.6-sol`, `xhigh` | Parent uses local tools directly; no subagent |
| `delegated_matched` (B) | Same as A | Exactly one bounded local child using `openai-codex/gpt-5.6-sol`, `xhigh` |
| `delegated_production` (C) | Same as A | Exactly one bounded local child using the checked-in profile preset |

Production child presets at protocol freeze time must be recorded rather than inferred later. The current expected mapping is lookup=`gpt-5.6-luna/medium`, analysis=`gpt-5.6-terra/medium`, and review=`gpt-5.6-sol/medium`.

Arm B must use a benchmark-only generated copy or wrapper of the extension. It must not modify the checked-in production extension. The generated source, effective model mapping, and SHA-256 hash are preserved with the run artifacts. The runner must fail closed when event telemetry reports a child model or thinking level different from the assigned arm.

Delegated arms retain the parent's local tools so that post-result reinvestigation can be measured. A benchmark-only parent scope guard canonicalizes and restricts every parent `read`, `grep`, `find`, and `ls` target to the exposed snapshot in all arms; prompt instructions alone are not treated as containment. The guard does not impose a tool-call limit, so the primary estimand continues to include the production child's bounded-tool policy. The prompt requests exactly one delegation and synthesis without broad rereading; noncompliance is recorded, not silently repaired.

## 3. Corpus

### 3.1 Confirmatory and calibration sets

- Confirmatory set: **90 independent tasks**: lookup 30, analysis 30, review 30.
- Calibration set: **12 separate tasks**, used only to stabilize prompts, parsers, scoring, and timeouts.
- No calibration task, repository snapshot, injected defect, or gold answer may enter the confirmatory set.
- Confirmatory tasks and rubrics are frozen before any confirmatory model output is viewed.

Each profile contains 20 historical tasks and 10 unseen injected tasks, giving 60 public historical tasks and 30 realistic semi-synthetic tasks overall.

### 3.2 Required balance

Within each 30-task profile:

- provenance: 20 `historical_fix`, 10 `injected`;
- scope size: 10 `small`, 10 `medium`, 10 `large`;
- noise: 10 `low`, 10 `medium`, 10 `high`;
- evidence layout: 15 `single_file`, 15 `multi_file`.

The dimensions need not be fully factorial, but the task manifest must publish the cross-tabulation. The corpus uses at least 12 public repositories, no repository supplies more than 10 tasks, at least three implementation languages are represented, and no language supplies more than 40% of tasks.

Scope tiers are determined from the exact files exposed to the model:

- `small`: 1-10 files and at most 100 KiB;
- `medium`: 11-50 files and at most 1 MiB;
- `large`: 51-250 files and at most 5 MiB.

A task that exceeds either bound belongs to the next tier. Tasks above the large bounds are excluded to keep the extension's bounded investigation policy applicable.

### 3.3 Task sources

Historical tasks use a public bug or defect at a pinned base commit and a later fix commit as the oracle. Injected tasks apply a fixed, reviewable defect patch to a pinned clean commit. Injection authors may not evaluate model outputs.

Every task records:

- public repository URL and license;
- base commit and, for historical tasks, oracle fix commit;
- base-source archive SHA-256, computed from the content-addressed base-commit export before any injection, and optional injection patch SHA-256;
- exact exposed roots, file count, byte count, and model-visible snapshot SHA-256, computed from the prepared snapshot after any injection and exclusions;
- objective, profile, strata, required claims, evidence spans, and judge anchors;
- a canonical task hash.

Base-source archives are produced with `git archive` or an equivalent content-addressed export. Evaluation snapshots are prepared offline from those archives. They contain no `.git` directory, issue discussion, fix patch, gold manifest, or hidden answer material. The model sees only the frozen source snapshot and task prompt.

### 3.4 Candidate selection and gold freeze

Before confirmatory execution:

1. Publish inclusion and exclusion rules and build a candidate pool.
2. Reject tasks with ambiguous or disputed oracle evidence, missing licenses, external-service requirements, generated evidence, or answers that require running code or using the web.
3. Select tasks within each stratum by deterministic SHA-256 ordering of stable candidate IDs, not by anticipated model performance.
4. Author gold claims and evidence from the base/oracle pair before seeing model output.
5. Independently verify task solvability, evidence lines, hashes, and scorer fixtures.
6. Canonicalize each task record without `task_sha256`, hash it, then store the hash in `task_sha256`.

The manifest is valid only when it contains exactly 90 unique task IDs, all required balances hold, claim weights total 40 per task, evidence IDs resolve, all snapshots match their hashes, and every task passes positive and negative scorer fixtures.

## 4. Prompt and answer contract

The objective text is byte-identical across arms. Only the arm instruction differs. Prompts and system configuration are hashed and archived.

The parent final answer uses a stable, parseable Markdown contract:

```text
Conclusion
<concise conclusion>

Findings
- <material claim>

Evidence
- path/to/file.ext:LINE[-LINE] — <what this supports>

Uncertainties
- <material uncertainty, or "None">
```

The contract is used equally in all arms. Raw tool syntax and child transcripts are prohibited. Scoring never uses a child result directly.

## 5. Execution design

Each task is run three times in each arm: **90 tasks x 3 arms x 3 repetitions = 810 task-arm runs**. Repetitions are repeated measurements, not independent samples.

### 5.1 Schedule

A block is one task-repetition combination and contains all three arms. There are 270 blocks. Within each profile, each of the six possible arm orders occurs exactly 15 times. Task-block order is randomized while keeping the three arms of a block close in time.

The schedule seed is derived after manifest freeze:

```text
SHA256("pi-subagent-benchmark-v2/schedule\n" + manifest_sha256)
```

Human-audit sampling uses the same construction with the domain string `pi-subagent-benchmark-v2/human-audit` so it cannot be tuned from judge scores.

### 5.2 Isolation and retry policy

- Every run uses a fresh temporary snapshot, `--no-session`, fixed Pi/extension commits, and no context files, skills, themes, or unrelated extensions except the benchmark-only parent scope guard and matched-arm wrapper.
- The parent scope guard and production child guard enforce access to only the declared local snapshot. No web capability is enabled.
- Provider cache reads and writes are not discarded; raw fields are recorded. Arm randomization distributes unpreventable cache and temporal effects.
- A local preflight failure before any model request may be rerun after correction. Both records and the reason are retained.
- A failure, partial result, provider error, or timeout after a model request starts remains the assigned outcome and is not replaced.
- Empty, failed, and timed-out user-facing answers receive quality score zero. Partial answers are scored as returned and separately flagged.
- No output is manually repaired.

Timeout, concurrency, execution dates, provider/model versions, maximum model sessions, and monetary ceiling must be frozen in the preregistration. Benchmark execution is blocked while any value is missing.

## 6. Telemetry

Telemetry is parsed from Pi JSON events and written to sidecar artifacts after each run. It is never inserted into the parent prompt.

For every parent assistant message, retain raw provider fields separately:

- `input`, `cacheRead`, `cacheWrite`, `output`, `reasoning`, `totalTokens`;
- all reported cost fields;
- provider, model, stop reason, timestamp, and message index.

For every tool result, retain tool name, byte size, error state, and nested usage. Child usage is read from the `pi_subagent` tool result and stored separately from parent assistant usage; it must not be counted twice.

Derived definitions:

- `parent_prompt_tokens_message = input + cacheRead + cacheWrite`;
- `parent_peak_prompt_tokens = max(parent_prompt_tokens_message)`;
- `parent_cumulative_prompt_tokens = sum(parent_prompt_tokens_message)`;
- `parent_tool_result_bytes = UTF-8 bytes of all parent tool-result text`;
- `parent_subagent_result_bytes = UTF-8 bytes of successful pi_subagent result text`;
- total tokens and cost = separately reported parent plus child fields, with no nested-usage duplication.

Byte counts and token estimates are labeled as such. They do not replace provider-reported prompt usage.

Also retain wall time, parent and child tool-call counts, actual child model/thinking, child status and `partialReason`, post-subagent parent investigation, process status, timeout phase, and bounded diagnostics.

## 7. Quality scoring

Only the parent final answer is scored.

### 7.1 Fixed 100-point rubric

- required factual claims: 40 points, deterministic manifest scorer;
- file/line citation accuracy: 20 points, deterministic path and line-overlap scorer;
- causal logic: 25 points, blinded independent LLM judge;
- completeness: 10 points, blinded independent LLM judge;
- suppression of unsupported claims: 5 points, blinded independent LLM judge.

Claim aliases, numeric tolerances, evidence spans, and weights are frozen in the task manifest. Substring recall alone is not a reported quality score. Citation precision and recall are also reported independently.

The judge receives only the task, answer, frozen rubric anchors, and gold evidence necessary to score it. It receives no arm, tested model, preset, child output, timing, token, or cost metadata. One answer is judged per request, the response must satisfy a JSON schema, and the exact judge provider/model/version, prompt hash, settings, and raw response are retained.

The judge should be from a different model family from Luna/Terra/Sol. Its exact provider and model must be frozen and authorized before execution. If OpenRouter is used, the provider/model, maximum call count, and maximum spend require explicit approval for that batch.

### 7.2 Human audit

A blinded human audits 162 outputs (20% of 810), stratified as 18 outputs in each profile-arm cell and balanced across repetitions. Sampling occurs from the manifest-derived seed before judge results exist.

The audit reports mean absolute error, intraclass correlation, and judge-minus-human bias by arm. The judge-based quality endpoint is considered validated only when all preregistered conditions hold:

- mean absolute total-score difference <= 5 points;
- ICC >= 0.75;
- range of arm-specific mean judge-minus-human bias <= 2 points.

If any condition fails, judge quality results are labeled provisional and no quality non-inferiority claim is made until human scoring is expanded under the preregistered escalation plan.

## 8. Outcomes and analysis

### 8.1 Primary comparison

A versus B estimates matched-model delegation.

Primary efficiency outcome:

```text
r_i = 1 - median(parent cumulative prompt tokens for B, task i)
          / median(parent cumulative prompt tokens for A, task i)
```

Report the paired median of `r_i`, a task-level stratified bootstrap 95% confidence interval, and the ratio of corpus-wide token totals. No minimum reduction target is imposed; negative values are reported unchanged.

Primary validity outcome is the paired task-level mean quality-score difference `B - A`. Quality non-inferiority is declared only if the lower bound of its 95% confidence interval is at least -3 points. This gate controls interpretation; it does not suppress efficiency results.

### 8.2 Secondary comparison and outcomes

A versus C estimates the complete production-configuration effect and is reported separately from A versus B.

Predeclared secondary outcomes:

- parent peak prompt tokens;
- parent tool-result and subagent-result bytes;
- parent plus child input/output/reasoning/cache tokens;
- reported API cost;
- wall time;
- parent and child tool calls;
- fact precision/recall and citation precision/recall;
- unsupported-claim count;
- complete, partial, failure, and timeout rates;
- post-subagent parent reinvestigation rate.

A context-saving-without-material-quality-loss conclusion requires both a positive context effect and validated quality non-inferiority. Otherwise the report describes the observed trade-off.

### 8.3 Statistical unit

For continuous run metrics, take the median of three repetitions within each task-arm first. Bootstrap tasks, not the 270 repeated runs. Use 10,000 stratified task bootstrap samples with 30 lookup, 30 analysis, and 30 review tasks represented in every sample. Preserve the bootstrap seed and sampled task indices.

Report overall, profile, provenance, scope-size, noise, and evidence-layout tables. Only overall A-versus-B outcomes are confirmatory; subgroup and A-versus-C analyses are labeled secondary or exploratory. Report confidence intervals rather than selecting claims from nominal p-values.

## 9. Required artifacts

A complete evaluation archive contains:

- preregistration and its SHA-256;
- frozen `tasks.jsonl`, task schema, manifest hash, and balance report;
- source URLs, commits, licenses, archive/patch hashes, and snapshot inventory;
- generated balanced schedule and seeds;
- exact parent, child, and judge prompts and hashes;
- Pi, extension, benchmark, and corpus commits;
- provider/model/version, thinking, dates, timeout, concurrency, and cache policy;
- one immutable raw event file and normalized run record per run;
- anonymized parent answers;
- automated scores, raw judge responses, and human audit records;
- bootstrap samples or reproducible seed plus analysis version;
- machine-readable `summary.json` and human-readable report;
- `SHA256SUMS` for the archive.

Raw task-arm mapping remains sealed from judge and human reviewers until their scores are final.

## 10. Execution gate

No confirmatory run starts until all of the following are true:

1. all 90 tasks and 12 calibration tasks pass corpus validation;
2. prompts, scorer fixtures, schemas, thresholds, models, timeout, and analysis code are frozen;
3. schemas and configuration validators enforce arm-specific child presence, required execution telemetry, and the assigned child model and thinking level;
4. the 12-task calibration completes without changing confirmatory tasks or thresholds;
5. the human-audit owner and escalation path are named;
6. provider/model session counts, expected wall time, and maximum spend are calculated;
7. the user explicitly approves the exact execution batch and any required external judge batch;
8. the preregistration and source tree are hashed.

Calibration may fix implementation defects in the runner or scorer. Any protocol change after confirmatory output is visible invalidates the confirmatory label and requires a new benchmark version.

## 11. Planned implementation boundary

Implementation should remain under this benchmark directory except for an optional test-only package script. It must not alter production `index.ts`, `shared.ts`, `subprocess.ts`, the companion skill, packaging sources, or unrelated worktree files.

Suggested modules:

```text
benchmark-v2/
  README.md
  schemas/
  corpus/                 # frozen manifests and source metadata, no model-visible gold in snapshots
  prompts/
  runner.py               # schedule and subprocess orchestration
  parent-scope-guard.ts    # test-only canonical scope enforcement for every arm
  matched-extension.py     # reproducible temporary Arm-B model override
  events.py               # parent/child event parser and sidecar telemetry
  scoring.py              # deterministic and judge result validation
  statistics.py           # task aggregation and bootstrap
  validate_corpus.py
  tests/
  artifacts/              # ignored local outputs; publish only reviewed result bundles
```

The implementation should use Python's standard library unless a dependency is separately approved.
