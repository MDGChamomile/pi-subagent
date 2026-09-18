# Pi Agent Kit v0.3.0

## Pi Subagent: safer result handling and native image support

- Return child results to the parent in a bounded JSON envelope with runtime-owned `status`, `partialReason`, and `outputTruncated` fields. The child answer remains a separate untrusted string, so child text cannot impersonate runtime completion or truncation status.
- Surface output truncation in the Pi tool-result summary and keep the whole serialized envelope within the output-byte cap.
- Accept Pi native `read` image responses up to 6 MiB per JSON line, including the base64 data produced by a 4.5 MiB image response.
- Keep local and web child tool sets strictly capability-specific, and document explicit skill invocation, child read-only behavior, and reproducible setup and live-check boundaries.
- Refresh package presentation with automatic and explicit delegation demos, a gallery thumbnail, and a simplified architecture diagram.

The npm package remains the paired Pi Subagent extension and skill. It introduces no runtime dependencies, automatic model calls, write access for children, or OS/network isolation.

## Also included in the repository

These resources are source-only and are not bundled in the `@mdgchamomile/pi-subagent` npm package.

### Jev tools

- Add consent-gated public-passage reranking with a real demonstration, offline SDK/Pi loading checks, and diagnostics for response-validation failures.
- Keep consent dialogs in English and retain safety disclosures around data sent to the configured provider.

### Session search and skills

- Add privacy-bounded session recall, including literal-term handling, malformed-session tolerance, read-failure reporting, and masking for complete quoted secrets and cookie headers.
- Add the defensive `security-audit` skill, bundle standalone licenses for skills, and improve standalone documentation for Deep Plan and related resources.

### Compaction and validation

- Simplify compaction-model telemetry parsing and align its verification guidance.
- Strengthen skill metadata validation and package/latest-Pi validation coverage.

## Installation

```bash
pi install npm:@mdgchamomile/pi-subagent@0.3.0
# Optional, for web investigations:
pi install npm:pi-web-access
```

Restart Pi or run `/reload` after updating. Pi Subagent requires Linux, Pi 0.84.2 or later, and access to the documented child models. Local searches require `rg` and `fd` or `fdfind`. Adopt Jev tools, session search, security audit, and pi-compaction-model separately from their source directories; the npm install above does not install them.

## Verification and publication gates

Before tagging, run the Pi Subagent typecheck, offline tests, and package check documented in [`DEVELOPMENT.md`](DEVELOPMENT.md). Confirm that the release commit is on `main` and `live-validation` has passed. Push tag `v0.3.0` to trigger npm Trusted Publishing, wait for the workflow to pass, then confirm the public registry metadata and create the matching GitHub Release. Preparing these notes does not publish the package, create a tag, or create a GitHub Release.
