# Evaluation and verification

These source-checkout procedures are for contributors. For installation, configuration, and the runtime contract, see the [user guide](README.md). Run commands below from the repository root. See [CONTRIBUTING.md](../../CONTRIBUTING.md#source-and-checks) for required offline checks.

## Evaluation

> [!CAUTION]
> The context evaluation starts fresh parent and child model sessions, sends the synthetic fixtures to the configured provider, and consumes model usage. Obtain authorization before running it. The default three-case run starts six parent sessions, with one child session in each delegated arm; a session may make more than one provider request.

Specify an available parent model and thinking level explicitly:

```bash
python3 extensions/pi-subagent/scripts/context_isolation_eval.py \
  --mode context \
  --main-model openai-codex/gpt-6-astra \
  --main-thinking medium
```

The command compares direct and delegated investigation against three fixed synthetic fixtures. Outcomes are not deterministic; use it as a bounded sanity check rather than durable performance evidence. If both `PI_PROVIDER` and `PI_MODEL` are set, the script can derive the parent model when `--main-model` is omitted, but explicit arguments are preferred for reproducibility.

Earlier benchmark material is kept in the [repository history](https://github.com/MDGChamomile/pi-subagent/tree/3cf3ece9dcedd7c686d42c37ca91eabd7b9ecb9f/extensions/pi-subagent/benchmark-v2), not in the current source: the unexecuted confirmatory [benchmark design](https://github.com/MDGChamomile/pi-subagent/blob/3cf3ece9dcedd7c686d42c37ca91eabd7b9ecb9f/extensions/pi-subagent/benchmark-v2/README.md) and its [offline evidence evaluator](https://github.com/MDGChamomile/pi-subagent/blob/3cf3ece9dcedd7c686d42c37ca91eabd7b9ecb9f/extensions/pi-subagent/benchmark-v2/OFFLINE_SCORING.md), a [12-task production-preset exploratory pilot](https://github.com/MDGChamomile/pi-agent-kit/blob/6770d67511ab19727164b1ea8d565c9bed2a6609/live/extensions/pi-subagent/benchmark-v2/pilots/2026-09-01-production-12-task/REPORT.md), and a [46-child Astra routing pilot](https://github.com/MDGChamomile/pi-subagent/blob/3cf3ece9dcedd7c686d42c37ca91eabd7b9ecb9f/extensions/pi-subagent/benchmark-v2/pilots/2026-09-05-astra-routing/REPORT.md) with its frozen-protocol runner, [`scripts/model_selection_eval.py`](https://github.com/MDGChamomile/pi-subagent/blob/3cf3ece9dcedd7c686d42c37ca91eabd7b9ecb9f/extensions/pi-subagent/scripts/model_selection_eval.py). The 12-task pilot found substantially lower parent-context growth with delegation, but wall time increased and the provisional quality measure favored direct investigation, so it does not establish quality non-inferiority. The routing pilot recommended retaining the then-current Luna/Terra/Sol medium mappings. Both are calibration results from one local codebase, not universal performance claims.

## Verification

Offline checks from the repository root (dependency installation may access npm; the checks make no model requests):

```bash
npm --prefix extensions/pi-subagent ci --include=dev --ignore-scripts
npm --prefix extensions/pi-subagent run typecheck
npm --prefix extensions/pi-subagent test
npm --prefix extensions/pi-subagent run package:check
```

Opt-in local smoke, only with authorization for model/provider usage:

```bash
python3 -B extensions/pi-subagent/scripts/context_isolation_eval.py \
  --mode smoke --capability local --preset all \
  --main-model openai-codex/gpt-6-astra --main-thinking medium
```

The live observation harness is Codex-specific and evaluates default presets, not arbitrary provider overrides. Use a dedicated Pi agent directory without `pi-subagent.json` for these opt-in commands. Offline configuration tests cover Anthropic/OpenRouter selection; they do not establish live provider compatibility.

The development dependencies are pinned to Pi 1.0.0, the declared minimum. The default offline suite includes Python evaluation-contract tests as well as the TypeScript runtime tests; Python 3 and `rg` are required. The scoped-search regression uses Pi's native grep tool and an existing ripgrep binary without downloading tools or making model requests. Live checks require the Node.js Pi installation and consume model/provider usage. `--preset all` (the default) runs every current runtime preset in a fresh parent session; select one with, for example, `--preset review-standard`. If both `PI_PROVIDER` and `PI_MODEL` are set, `--main-model` may be omitted, but explicit parent model and thinking arguments are preferred for reproducibility.

Live checks verify the requested preset/capability/scope, returned model/thinking, complete untruncated output, usage, evidence, and absence of parent investigation. A test-only observer loads before the production guard and independently checks the effective child model/thinking, outgoing model/reasoning fields, and returned model identity. It records only configuration metadata in temporary files, never prompts, response text, headers, or credentials. The observer does not block requests: the evaluator checks every recorded request after the run, while the production guard independently blocks effective model/thinking mismatches before transmission. A wire-payload mismatch can therefore be detected only after a request has occurred. Missing observations and silent thinking clamping fail the check. It does not change production presets or global model configuration.

The web smoke is a source-checkout test. It uses the checked-in `scripts/web-smoke-parent.ts` helper, not a personal loader. Install and review a compatible `pi-web-access` package separately, with authorization, then locate its declared extension entry file in that package's `package.json` (`pi.extensions`). Pass the actual existing entry file explicitly; npm, git, and custom installation locations work without a fixed agent-directory layout. No dependency is downloaded by the smoke script.

With authorization for the model/provider usage described above:

```bash
python3 -B extensions/pi-subagent/scripts/context_isolation_eval.py \
  --mode smoke --capability web --preset all \
  --web-extension /path/to/pi-web-access/index.ts \
  --main-model openai-codex/gpt-6-astra --main-thinking medium
```

Replace `/path/to/pi-web-access/index.ts` with your package's declared entry file. A missing `--web-extension` or non-file path fails before any model session starts. Local smoke does not require or resolve this option. The source-only helper is not installed into the active Pi environment and is not included in the npm package.

The helper loads last in the parent, keeps `pi-web-access` tools registered with their original provenance, activates only `pi_subagent`, and blocks other parent tool calls. The helper is not loaded in the child; the existing test observer and production guard remain in place, and package/version/entry-point checks are unchanged. No CLI tool allowlist is applied to the web-smoke parent, because Pi would remove the web tools from its registry rather than merely hiding them from the model. The smoke fetches IANA's example-domain documentation without searching, requires a test-only observation of a successful single-target `fetch_content` call with nonempty content, requires verbatim body evidence for both the documentation purpose and registration/transfer restriction, and fails on any parent investigation or loader call. The fetch observation records only target-match and success booleans, never URLs, content, or credentials; this does not expand production telemetry. Offline tests verify command assembly, early failures, and helper behavior; live provider/web compatibility requires a separately authorized smoke run.

The default offline suite covers final-answer isolation, complete and partial outcomes, tool-disabled finalization, empty answers, bounded provider errors, cancellation, timeout escalation, abrupt parent exit, usage aggregation, scope, recoverable web denials, and tool ownership. `provider-guard.test.ts` also runs a real SDK session through the built-in `openai-codex-responses` SSE implementation, using synthetic in-memory OAuth-shaped data and a stubbed fetch response. It verifies actual provider `onPayload` delivery to `before_provider_request`, a successful parsed response, and synchronous guard exit before fetch on model/thinking mismatch. A throwing-hook control verifies that ordinary hook exceptions are swallowed rather than reliably blocking transmission. The isolated fixture replaces HOME and resource paths and blocks network socket attempts; it neither reads real credentials nor calls a provider. This tests only the default Codex API's SSE path, not WebSocket, other providers, live compatibility, or the full CLI subprocess path. The existing default test glob includes it in pinned validation and in the scheduled canary when the change reaches its checkout branch; no canary run is implied by a local pass. Opt-in smoke tests cover live model selection and the local/web runtime boundaries.
