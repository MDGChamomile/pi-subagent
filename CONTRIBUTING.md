# Contributing

Keep changes focused and consistent with the [canonical harness principles](https://github.com/MDGChamomile/MDGChamomile/blob/main/PRINCIPLE.md), linked from this repository's [PRINCIPLE.md](PRINCIPLE.md). Maintain the principles in the canonical repository, not here. For offline work, use the local boundaries in [AGENTS.md](AGENTS.md): keep procedures lean without weakening scope, privacy, authorization, or lifecycle safeguards. Explain the problem, observable benefit, and affected runtime or packaging contract.

## Pull requests

Task pull requests target `updates`, not the default branch `main`. If a PR
accidentally targets `main`, change its base to `updates` and review the resulting
diff and checks again. Use **Summary / Verification / Risk** in the description:
explain the change, checks actually run and their limitations, and affected
contracts or rollback considerations. Follow [Source and checks](#source-and-checks)
for the changed area.

Preserve `main` and `updates`: do not push directly to them, delete them, or
rewrite their history. The repository currently merges PRs with merge commits.
For `updates`, the required checks are `skills` and `subagent`, and review
conversations must be addressed and resolved before merging. A successful check
or bot run is not review approval; the current rules do not enforce a minimum
approval count. The actual [GitHub rules](https://github.com/MDGChamomile/pi-subagent/rules)
and repository merge settings are authoritative, not this description.

When configured automatic review applies, PR content and repository context are
sent to an external review service. See the [review-only policy](.github/PULLFROG.md).
Do not include credentials or private session content; do not manually trigger
paid reviews without explicit authorization.

### External contributors

Fork the repository, then clone your fork (`origin` is your fork) and add the
original repository as `upstream`. Replace `YOUR-USER` and the task branch name:

```bash
git clone https://github.com/YOUR-USER/pi-subagent.git
cd pi-subagent
git remote add upstream https://github.com/MDGChamomile/pi-subagent.git
git fetch upstream updates
git switch --no-track -c task/short-description upstream/updates
# Make focused changes, verify them, and commit the intended files.
git push -u origin task/short-description
```

Open a PR from your fork's task branch to **MDGChamomile/pi-subagent:updates**.
External contributors are not responsible for merging `main` or synchronizing
release history; maintainers handle that separately.

### Maintainer development

Start each task from the latest remote `updates`, work on a local task branch,
and push only that branch when authorized:

```bash
git fetch origin updates
git switch --no-track -c task/short-description origin/updates
# Make focused changes, verify them, and commit the intended files.
git push -u origin task/short-description
```

Open and review an `updates` PR, address findings, verify the latest head and
applicable checks, then merge when authorized. After merging:

```bash
git fetch origin updates
git switch updates
git merge --ff-only origin/updates
```

Local `updates` tracks merged remote work; it is not a place to accumulate
unmerged task commits. Preserve unrelated changes or existing unmerged work on
a separate branch before switching or synchronizing; do not reset or force-push
to resolve divergence. These procedures do not themselves authorize commits,
pushes, merges, or branch deletion. Delete task branches only with explicit
authorization, after verifying they are merged and not in use by a worktree.

A release PR from `updates` to `main` requires a separate explicit release request
and uses a merge commit. Afterwards, a code-free release merge record existing
only on `main` is normal; making the two branch SHAs equal is not the goal.
Before carrying such history back, fetch both branches and inspect it:

```bash
git fetch origin main updates
git log --oneline origin/updates..origin/main
git diff --exit-code "$(git merge-base origin/main origin/updates)" origin/main
```

Verify that the main-only commits really are completed `updates` → `main`
release merge records and that `main` has the same file tree as the common
ancestor; the empty diff alone does not establish their provenance. With explicit
authorization, merge the verified release history normally into the next
maintainer task branch and include it in that task's existing `updates` PR.
Unexpected code changes or conflicts need separate confirmation. Consider a
standalone history PR only when needed, such as an explicit request for immediate
synchronization; do not create an empty or duplicate PR if `main` is already an
ancestor of `updates`.

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

The development lockfile and CI pin Pi 1.0.0, the declared minimum; the weekly canary tests current upstream Pi packages separately. An independent `latest-web` canary job installs `pi-web-access@latest` only in its disposable test environment and checks its registered Pi request schemas against the guard's allowlist and representative original/normalized inputs. It never invokes the tools or starts a model session. Regular validation tests the checker with synthetic schemas and breaking-change controls; it does not install the web dependency.

To reproduce the web schema canary in a disposable checkout:

```bash
npm --prefix extensions/pi-subagent ci --ignore-scripts
npm --prefix extensions/pi-subagent install --no-save --package-lock=false --ignore-scripts pi-web-access@latest
npm --prefix extensions/pi-subagent run test:web-schema
```

Package installation accesses npm. Schema discovery runs in a bounded child with a temporary HOME/config directory, no inherited credentials, and network/subprocess tripwires; this is not an OS sandbox for untrusted dependencies. The check detects missing tools/keys and representative type, required-field, enum, and limit incompatibilities, not every possible request or semantic change. It does not establish live provider compatibility, SSRF behavior, or compatibility with custom web configurations. Scheduled canaries use the default branch, so changes merged only to `updates` take effect on the schedule after a release to `main`; an authorized `workflow_dispatch` can test a task branch earlier.

`npm test` preloads `scripts/pi-sdk-test-loader.mjs` to select Pi's bundled SDK when available. When running a TypeScript test directly from `extensions/pi-subagent`, keep that preload, for example `node --import ./scripts/pi-sdk-test-loader.mjs --experimental-strip-types --test child-retry.test.ts`. The provider/selection fixtures receive the same preload from their spawning tests; package discovery chooses its SDK independently. Dependency installation can access registries. The checks do not call models. Package validation rebuilds ignored `dist/`, verifies the exact npm file set and documentation links, and runs isolated offline resource discovery plus negative controls.

For documentation changes, review relative links and commands; for runtime changes, add regression coverage and run all three runtime/package checks. The skill validator covers metadata and relative links in `SKILL.md` and the maintained root documents (`README.md`, `AGENTS.md`, `MIGRATION.md`, `CONTRIBUTING.md`, `PRINCIPLE.md`) plus `packaging/pi-subagent/DEVELOPMENT.md`; it does not check semantic compatibility.

Keep superseded evaluation material in repository history and link it by commit instead of retaining it in the current tree. Historical protocols and hashes describe earlier code; do not rewrite them to imply validation of current code. Live smoke/evaluation commands consume provider usage, can disclose inputs, and require separate authorization. The web smoke uses a checked-in parent helper and requires an explicit `--web-extension` path to a separately installed, reviewed `pi-web-access` entry file. See the [extension guide](extensions/pi-subagent/README.md#verification).

Repository changes do not authorize copying, linking, or installing into an active Pi environment. Never commit credentials, private session content, generated dependencies, or local machine configuration.

See [package maintenance](packaging/pi-subagent/DEVELOPMENT.md) for release procedures. Passing local checks does not publish or authorize a release. Contributions are licensed under [MIT](LICENSE).
