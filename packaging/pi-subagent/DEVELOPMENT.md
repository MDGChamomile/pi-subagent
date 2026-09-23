# Pi Subagent package maintenance

The npm package is assembled from the canonical files under `extensions/pi-subagent` and `skills/pi-subagent`. The package-only root entrypoint is maintained in `packaging/pi-subagent/index.ts`; its relative import targets the staged layout. It forwards to the unchanged extension implementation so Pi's compact npm label is `@mdgchamomile/pi-subagent`, without the redundant `:pi-subagent` suffix. Do not edit generated files under `dist/`.

## Verify a package candidate

From the repository root:

```bash
npm --prefix extensions/pi-subagent run typecheck
npm --prefix extensions/pi-subagent test
npm --prefix extensions/pi-subagent run package:check
```

`package:check` rebuilds the ignored `packaging/pi-subagent/dist/` directory, runs `npm pack --dry-run`, verifies the exact tarball file set and Pi resource paths, checks that the source and npm READMEs agree on shared installation requirements and fixed preset mappings, checks bundled relative Markdown links and version-matched absolute top-level guide links, and loads the staged package manifest through Pi's SDK resource loader with an isolated offline configuration. It uses the development package's selected Pi version, asserts error-free extension loading, exactly one `pi_subagent` tool and the companion skill, and runs negative controls for broken imports, missing tool registration, and missing skill discovery. No model session or provider request is created.

Before publishing, inspect the generated manifest and dry-run report:

```bash
npm pack --dry-run --json ./packaging/pi-subagent/dist
```

## Historical live verification

### Astra-parent source smoke (2026-09-15)

With Pi 0.85.1, Node.js 22.22.3, and `pi-web-access` 0.29.0, the source extension was tested with `openai-codex/gpt-6-astra` / `medium` parents and unchanged Luna/Terra/Sol / `medium` child presets. **Five of six checks passed**: all three local presets and web lookup/analysis. Web review returned a complete, cited answer but omitted the required documentation-purpose quotation, so that case failed and was not retried. All six runs passed the remaining checks, including effective and wire model/thinking, response identity, usage, scope, and no parent investigation. This is not an all-green web compatibility result or an Astra performance benchmark; the earlier Sol-parent performance evidence remains unchanged.

The authorized rerun made 24 provider requests. Its temporary harness used isolated settings and synthetic/public inputs, forced SSE, disabled retries and automatic compaction, imposed a 60-second signal per request, and gated the actual transport fetch callback at four requests per parent and eight per child, with at most one child per parent. These extra limits are not implemented by the standard smoke commands in the [extension guide](../../extensions/pi-subagent/README.md#verification). A preliminary local lookup passed the functional checks but exposed a fetch-instrumentation gap after two observed parent and two observed child requests; it was stopped and retained separately. The corrected gate passed offline tests against SDK and bundled Codex transports before the explicitly authorized rerun. Source-only checks, counts, failure details, and source/harness hashes are recorded in the [verification record](../../extensions/pi-subagent/verification/2026-09-15-astra-medium.json); temporary harnesses and raw provider streams are not bundled.

## Trusted Publishing setup

The first independent release uses `0.4.0`. Before publishing, verify npm's actual publisher settings and confirm that the selected version is unused. For the transition from `pi-agent-kit`, stop its release workflow and replace its trusted-publisher connection with the configuration below. npm connections cannot be edited in place: create the new connection and remove the superseded one, retaining only the intended release connection. Historical kit tags were not imported, and the old npm `0.3.0` remains immutable. See [MIGRATION.md](../../MIGRATION.md).

The package publishes through `.github/workflows/npm-publish.yml` without an npm token. Configure its single trusted publisher on the npm package settings page with:

- provider: GitHub Actions;
- organization or user: `MDGChamomile`;
- repository: `pi-subagent`;
- workflow filename: `npm-publish.yml`;
- environment: none;
- allowed action: `npm publish`.

The workflow must exist on the default branch before this relationship is configured. It uses a GitHub-hosted runner, grants only `contents: read` and `id-token: write`, verifies that the stable package version matches the tag and that the tagged commit is on `main`, then reruns typecheck, tests, and package validation before publishing through OIDC.

## Release

1. Set the new immutable version in `manifest.json`; its pinned gallery image URL must use the same version tag.
2. Run all verification commands above.
3. Merge the release commit into `main` and wait for `validation` to pass.
4. Push the matching `v<version>` tag. The tag triggers `npm-publish.yml`. All `v*` tags are reserved for package releases; a tag that does not exactly match the stable manifest version fails before installation or publishing. Use a non-`v*` tag name for non-package milestones; those tags do not trigger npm publishing.
5. Wait for the publish workflow to pass, then confirm the registry metadata and Pi package manifest:

   ```bash
   npm view @mdgchamomile/pi-subagent name version keywords pi
   ```

6. Create the matching GitHub Release after the npm version is visible publicly.

Never reuse or overwrite a version that has reached the public registry. Do not store registry tokens in the repository or GitHub Actions; Trusted Publishing supplies a short-lived OIDC credential for each release.
