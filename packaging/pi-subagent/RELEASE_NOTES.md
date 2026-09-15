# Pi Agent Kit v0.2.8

## Pi Subagent: package presentation and validation

- Load the npm package through a root `index.ts` forwarding to the existing extension. Pi's compact package label is now `@mdgchamomile/pi-subagent`, without the redundant `:pi-subagent` suffix.
- Verify the assembled package through Pi's SDK resource loader: error-free extension loading, exactly one `pi_subagent` tool, and discovery of the companion skill. Negative controls reject broken imports, missing tool registration, and missing skill discovery.
- Strengthen the latest-Pi canary with typechecking and visible failures; tests still run after a typecheck failure.

The npm package remains the paired Pi Subagent extension and skill. Runtime investigation logic, model presets, and scope/budget boundaries are unchanged. No new runtime dependencies or automatic model calls are introduced.

## Also included in the repository

These resources are source-only and are not bundled in the pi-subagent npm package.

### simplykst: DART-first Korean stock analysis

- Add separate Trading (1–12 weeks) and Investing (1–3 years) ratings, six factors per perspective, and nine sector profiles, with explicit evidence grades, missing-data handling, and confirmed-risk limits.
- Include an offline calculator supporting one or both perspectives, sector/mixed-sector weight validation, withholding reasons, and safe rejection of unknown fields and duplicate JSON keys. Tests cover unequal-score weighted means, missing factors, risk precedence, CLI errors, and display rounding.
- Lead reports with conclusions, valuation, and conditions that would change the assessment. Keep evidence and weights in four-column factor tables, with reproducible calculations and source locations below. Korean prose guidance preserves facts, uncertainty, and the distinction between plans and execution.
- When material to the decision, compare changes in management's explanations against actual indicators and trace market variables through company-specific exposures. These are conditional analysis prompts, not extra sentiment scores or mandatory market forecasts.

Ratings are analytical heuristics, not a backtested strategy, return probabilities, or personalized suitability assessments. Synthetic tests and presentation examples do not establish investment performance or reliable execution across real companies. Source-access and validation limitations remain documented in the skill.

### pi-compaction-model and source verification

- Expose a root extension entrypoint so Pi displays the containing extension name rather than `src`; add frozen-lockfile validation to CI.
- Record source smoke results with an Astra/medium active model and Luna/medium dedicated compaction: two dedicated compactions and one induced native fallback preserved cumulative file lists and active model settings.
- Record Pi Subagent Astra/medium-parent source smoke results: all three local presets and web lookup/analysis passed. Web review returned a cited answer but omitted a required quotation, so only five of six checks passed. This is not an all-green web compatibility claim or a performance benchmark.

## Installation

```bash
pi install npm:@mdgchamomile/pi-subagent@0.2.8
# Optional, for web investigations:
pi install npm:pi-web-access
```

Restart Pi or run `/reload` after updating. Pi Subagent requires Linux, Pi 0.84.2 or later, and access to the documented child models. Local searches require `rg` and `fd` or `fdfind`. Adopt simplykst and pi-compaction-model separately from their source directories; the npm install above does not install them.

## Verification and publication gates

Release preparation checks typechecking, the offline tests, the exact npm tarball file set, version-pinned documentation/assets, and isolated Pi package loading with negative controls. CI validates skills, pi-compaction-model, and Pi Subagent against Pi 0.84.2 and 0.85.0. The recorded live smoke tests above are separate source results with their own limits, not fresh provider tests of the final npm artifact.

Before publishing these notes, confirm that the release commit is on `main`, its validation has passed, and npm Trusted Publishing has successfully published version 0.2.8. Then verify public registry metadata and create the GitHub Release for `v0.2.8`. Preparing this file does not publish the package or create the tag or GitHub Release.
