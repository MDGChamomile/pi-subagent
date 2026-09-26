# Agent guidance

Pi Subagent delegates bounded, read-only investigations to ephemeral child Pi processes. The extension enforces boundaries; the companion skill guides delegation. Implementation and final verification remain with the parent.

Follow [PRINCIPLE.md](PRINCIPLE.md): keep procedures thin and boundaries firm. Start with the simplest solution that preserves the objective and core constraints. Load task-specific documentation as needed; do not replace runtime enforcement with prompt instructions or require delegation for routine work.

## Core boundaries

- Preserve explicit local scope, canonical path checks, tool provenance, and separate local and web capabilities. Children must not write files, execute shell commands or tests, persist Pi sessions, or recursively delegate.
- Preserve resource budgets, cancellation and process cleanup, readiness verification, bounded output, and the distinction between runtime-owned status and untrusted child content.
- Keep telemetry content-free: do not include tasks, paths, queries, URLs, source content, credentials, or private sessions in execution metadata. Never commit private data or local machine configuration.
- This is an application-level capability boundary, not an OS, network, or credential-isolated sandbox. Do not claim stronger isolation.
- Changes to core boundaries require clear justification and explicit owner approval. Repository edits do not authorize active-environment installation, live provider calls, or publication.

## Source map

- `extensions/pi-subagent/`: TypeScript runtime, regression tests, and historical evaluation records. Read the [extension guide](extensions/pi-subagent/README.md) when changing runtime contracts.
- `skills/pi-subagent/`: delegation guidance; keep it consistent with enforced runtime capabilities.
- `packaging/pi-subagent/`: maintained assembly and validation code. Do not hand-edit generated `dist/`. Read [package maintenance](packaging/pi-subagent/DEVELOPMENT.md) for packaging or release work.
- `.github/scripts/`: skill validation and its Python tests.

## Workflow and verification

- Create task branches from the latest `updates` branch and target `updates` for task PRs unless the user requests otherwise.
- Release PRs from `updates` to `main` require an explicit release request; merge them with a merge commit. If changes land directly on `main`, merge `main` back into `updates` rather than resetting or force-pushing.
- Branch conventions do not authorize commits, pushes, PRs, merges, or branch deletion. Preserve `main` and `updates`; delete task branches only with explicit authorization.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for setup and checks. Add meaningful regression coverage for runtime changes and run its runtime typecheck, tests, and package validation. Run the relevant Python checks for skill or validator changes.
- For documentation-only changes, verify accuracy, relative links, and commands. Run package validation when packaged documentation or assembly is affected.
- Preserve historical evaluation protocols and hashes as historical evidence, not proof of current behavior. Offline checks do not call models or establish live compatibility; live tests require separate authorization for provider usage and input disclosure.
