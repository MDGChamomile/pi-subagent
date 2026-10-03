# Contributing

Keep changes focused and consistent with the [canonical harness principles](https://github.com/MDGChamomile/MDGChamomile/blob/main/PRINCIPLE.md), linked from this repository's [PRINCIPLE.md](PRINCIPLE.md). Maintain the principles in the canonical repository, not here. For offline work, use the local boundaries in [AGENTS.md](AGENTS.md): keep procedures lean without weakening scope, privacy, authorization, or lifecycle safeguards. Explain the problem, observable benefit, and affected runtime or packaging contract.

## Pull requests

Create your contribution branch from the latest `updates` branch, and select
`updates` as the base branch when opening a pull request. GitHub may suggest
`main` because it is the repository's default branch; please change the base
to `updates` before submitting.

Contributions are reviewed and merged into `updates`. Maintainers open pull
requests from `updates` to `main` only when preparing a release. If you
accidentally target `main`, the base can be changed to `updates`; the resulting
diff and checks should then be reviewed again.

## Source and checks

Edit `extensions/pi-subagent/`, `skills/pi-subagent/`, or the maintained files in `packaging/pi-subagent/`, not generated `packaging/pi-subagent/dist/`.

From the repository root, with Node.js 22.22+, Python 3.10+, and `rg`:

```bash
npm --prefix extensions/pi-subagent ci --include=dev --ignore-scripts
npm --prefix extensions/pi-subagent run typecheck
npm --prefix extensions/pi-subagent test
npm --prefix extensions/pi-subagent run package:check
python3 -B -m unittest discover -s .github/scripts -p 'test_*.py' -v
python3 -B .github/scripts/validate_skills.py
```

The development lockfile and CI pin Pi 1.0.0, the declared minimum; the weekly canary tests current upstream packages separately. Dependency installation can access registries. The checks do not call models. Package validation rebuilds ignored `dist/`, verifies the exact npm file set and documentation links, and runs isolated offline resource discovery plus negative controls.

For documentation changes, review relative links and commands; for runtime changes, add regression coverage and run all three runtime/package checks. The skill validator covers metadata and relative links in `SKILL.md`, not every README or semantic compatibility.

Keep superseded evaluation material in repository history and link it by commit instead of retaining it in the current tree. Historical protocols and hashes describe earlier code; do not rewrite them to imply validation of current code. Live smoke/evaluation commands consume provider usage, can disclose inputs, and require separate authorization. The web smoke uses a checked-in parent helper and requires an explicit `--web-extension` path to a separately installed, reviewed `pi-web-access` entry file. See the [extension guide](extensions/pi-subagent/README.md#verification).

Repository changes do not authorize copying, linking, or installing into an active Pi environment. Never commit credentials, private session content, generated dependencies, or local machine configuration.

See [package maintenance](packaging/pi-subagent/DEVELOPMENT.md) for release procedures. Passing local checks does not publish or authorize a release. Contributions are licensed under [MIT](LICENSE).
