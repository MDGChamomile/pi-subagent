# Pi Agent Kit v0.2.7

## Pi Subagent: scoped search and shutdown fixes

- Local children no longer inherit `RIPGREP_CONFIG_PATH`. User-configured ripgrep options such as `--follow` could otherwise make a recursive search follow an in-scope symlink into files outside the authorized scope. The parent's environment remains unchanged.
- Cancellation, timeout, and child JSON protocol errors now wait for process-group SIGKILL escalation even when the direct child exits before its descendants. The existing 5-second grace period is retained; cancellation and timeout reporting can therefore wait for that cleanup. Normal completion does not add this wait.
- Centralize invocation permits in the parent gate, preserving one-time execution, call reservations, and preflight retry limits.
- Separate web-input validation and preparation from mutation. Apply normalized inputs only after budget admission, leaving denied inputs unchanged.
- Add regression coverage for scoped search, descendant cleanup, invocation permits, and web-input preparation.

The npm package remains the paired Pi Subagent extension and skill. No new model calls or runtime dependencies are introduced.

## Also included in the repository

These resources are source-only and are not bundled in the pi-subagent npm package:

- Add the independently maintained `pi-compaction-model` derivative for routing native compaction to a dedicated model, with upstream MIT attribution and source-install guidance.
- Add opt-in additional session directories to Session Search; retain project filters, evidence-consent requirements, and path-free default output. Reuse CLI help within a session when still applicable.
- Store new Deep Plan records under the skill's `records/` directory by default, while preserving explicit destinations and existing records.
- Add an offline evidence diagnostic evaluator for citation bounds, gold-span overlap, and lexical checks. It does not establish semantic validity or overall answer quality.
- Clarify that harness evaluations should compare against a minimal baseline preserving the same core boundaries.

## Installation

```bash
pi install npm:@mdgchamomile/pi-subagent@0.2.7
# Optional, for web investigations:
pi install npm:pi-web-access
```

Restart Pi or run `/reload` after updating. Pi Subagent requires Linux, Pi 0.84.2 or later, and access to the documented child models. Local searches require `rg` and `fd` or `fdfind`.

## Verification scope

The offline suite exercises synthetic boundary and lifecycle cases. Validation, publishing, and canary workflows provision ripgrep before running the search regression. Package validation checks the tarball file set, version-matched documentation links, and offline Pi resource discovery. Live model/web compatibility smoke tests are not part of this release preparation.

Before publishing these notes, confirm that the release commit is on `main`, its validation has passed, and npm Trusted Publishing has successfully published version 0.2.7. Preparing this file does not publish the package or create the GitHub Release.
