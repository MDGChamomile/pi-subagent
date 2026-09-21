# Contributing

Keep changes focused and consistent with [PRINCIPLE.md](PRINCIPLE.md). Explain the problem, observable benefit, and affected runtime or packaging contract. Preserve scope, privacy, authorization, and lifecycle boundaries.

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

The development lockfile pins Pi 0.85.0. CI also checks Pi 0.84.2; the weekly canary tests current upstream packages separately. Dependency installation can access registries. The checks do not call models. Package validation rebuilds ignored `dist/`, verifies the exact npm file set and documentation links, and runs isolated offline resource discovery plus negative controls.

For documentation changes, review relative links and commands; for runtime changes, add regression coverage and run all three runtime/package checks. The skill validator covers metadata and relative links in `SKILL.md`, not every README or semantic compatibility.

Retain source-only evaluation and verification records. Historical frozen protocols and hashes describe earlier code; do not rewrite them to imply validation of current code. Live smoke/evaluation commands consume provider usage, can disclose inputs, and require separate authorization. The web smoke additionally needs a reviewed maintainer-provided loader not bundled here. See the [extension guide](extensions/pi-subagent/README.md#verification).

Repository changes do not authorize copying, linking, or installing into an active Pi environment. Never commit credentials, private session content, generated dependencies, or local machine configuration.

See [package maintenance](packaging/pi-subagent/DEVELOPMENT.md) for release procedures. Passing local checks does not publish or authorize a release. Contributions are licensed under [MIT](LICENSE).
