# Pi Subagent

A foreground Pi extension and companion skill for focused, bounded local-file or web investigations outside the parent context.

```bash
pi install npm:@mdgchamomile/pi-subagent
```

Requires Linux (including Ubuntu on WSL), Pi 0.84.2+, and access to the documented `openai-codex` child models. Local search needs `rg` and `fd`/`fdfind`; web investigations additionally need `pi-web-access` 0.27.0+ stable. The package is an application-level capability boundary, not an OS or credential-isolated sandbox.

- [Extension guide](extensions/pi-subagent/README.md): requirements, source installation, runtime/security contract, demos, evaluation, and verification.
- [Companion skill](skills/pi-subagent/README.md): when and how to delegate.
- [Contributing](CONTRIBUTING.md): development setup and checks.
- [Package maintenance](packaging/pi-subagent/DEVELOPMENT.md): assembly and release procedures.
- [Migration](MIGRATION.md): repository history and existing installation paths.
- [Design principles](PRINCIPLE.md).

The canonical source is in `extensions/pi-subagent/` and `skills/pi-subagent/`. `packaging/pi-subagent/` assembles the focused npm package; generated `dist/` files are not a second source tree. Source-only tests, evaluation fixtures, and verification records are retained even when not bundled in npm.

## Verification

From the repository root, with Node.js 22.22+, Python 3, and `rg`:

```bash
npm --prefix extensions/pi-subagent ci --include=dev --ignore-scripts
npm --prefix extensions/pi-subagent run typecheck
npm --prefix extensions/pi-subagent test
npm --prefix extensions/pi-subagent run package:check
python3 -B -m unittest discover -s .github/scripts -p 'test_*.py' -v
python3 -B .github/scripts/validate_skills.py
```

Dependency installation accesses npm. These checks make no model requests; package validation uses isolated offline Pi discovery. Live evaluations are opt-in and require separate authorization for provider usage and data disclosure. Repository changes do not update an installed Pi environment automatically.

## License

[MIT](LICENSE)
