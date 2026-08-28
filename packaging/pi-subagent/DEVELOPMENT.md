# Pi Subagent package maintenance

The npm package is assembled from the canonical files under `live/extensions/pi-subagent` and `live/skills/pi-subagent`. Do not edit generated files under `dist/`.

## Verify a package candidate

From the repository root:

```bash
npm --prefix live/extensions/pi-subagent run typecheck
npm --prefix live/extensions/pi-subagent test
npm --prefix live/extensions/pi-subagent run package:check
```

`package:check` rebuilds the ignored `packaging/pi-subagent/dist/` directory, runs `npm pack --dry-run`, verifies the exact tarball file set and Pi resource paths, checks bundled relative Markdown links and version-matched absolute top-level guide links, and loads the staged package through Pi with an isolated offline configuration.

Before publishing, inspect the generated manifest and dry-run report:

```bash
npm pack --dry-run --json ./packaging/pi-subagent/dist
```

## Trusted Publishing setup

The package publishes through `.github/workflows/npm-publish.yml` without an npm token. Configure its single trusted publisher on the npm package settings page with:

- provider: GitHub Actions;
- organization or user: `MDGChamomile`;
- repository: `pi-agent-kit`;
- workflow filename: `npm-publish.yml`;
- environment: none;
- allowed action: `npm publish`.

The workflow must exist on the default branch before this relationship is configured. It uses a GitHub-hosted runner, grants only `contents: read` and `id-token: write`, verifies that the stable package version matches the tag and that the tagged commit is on `main`, then reruns typecheck, tests, and package validation before publishing through OIDC.

## Release

1. Set the new immutable version in `manifest.json`; its pinned gallery image URL must use the same version tag.
2. Run all verification commands above.
3. Merge the release commit into `main` and wait for `live-validation` to pass.
4. Push the matching `v<version>` tag. The tag triggers `npm-publish.yml`.
5. Wait for the publish workflow to pass, then confirm the registry metadata and Pi package manifest:

   ```bash
   npm view @mdgchamomile/pi-subagent name version keywords pi
   ```

6. Create the matching GitHub Release after the npm version is visible publicly.

Never reuse or overwrite a version that has reached the public registry. Do not store registry tokens in the repository or GitHub Actions; Trusted Publishing supplies a short-lived OIDC credential for each release.
