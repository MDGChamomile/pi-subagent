# Pi Subagent package maintenance

The npm package is assembled from the canonical files under `extensions/pi-subagent` and `skills/pi-subagent`, plus the repository-root `README.md`. The package-only root entrypoint is maintained in `packaging/pi-subagent/index.ts`; its relative import targets the staged layout. It forwards to the unchanged extension implementation so Pi's compact npm label is `@mdgchamomile/pi-subagent`, without the redundant `:pi-subagent` suffix. Do not edit generated files under `dist/`.

## Verify a package candidate

From the repository root:

```bash
npm --prefix extensions/pi-subagent run typecheck
npm --prefix extensions/pi-subagent test
npm --prefix extensions/pi-subagent run package:check
```

`package:check` rebuilds the ignored `packaging/pi-subagent/dist/` directory, runs `npm pack --dry-run`, verifies the exact tarball file set and Pi resource paths, checks canonical README requirements and preset mappings against the runtime, verifies that the generated npm README preserves the complete body with rebased image/document links, checks bundled relative Markdown links and version-matched absolute top-level guide links, and loads the staged package manifest through Pi's SDK resource loader with an isolated offline configuration. It uses the development package's selected Pi version, asserts error-free parent and child extension loading, exactly one `pi_subagent` tool and the companion skill, and runs negative controls for parent-only and child-only broken imports, missing tool registration, and missing skill discovery. Child discovery checks module loading only; it does not start a child session or verify runtime readiness. No model session or provider request is created.

`manifest.json` supplies the authoritative package version. The repository-root `README.md` is the only maintained top-level README body; there is no separate packaging README to edit. During assembly, `build.mjs` generates `dist/README.md`, converting relative image links to version-matched raw GitHub URLs and relative document links to GitHub blob URLs while preserving the full text and anchors. Repository-only documentation links remain available as absolute links. External URLs and local anchors are preserved, except this repository's already-versioned GitHub/raw GitHub URLs are rebased to the manifest version, as is `pi.image`. Maintained files are never changed by the build. The bundled extension guide also gets version-matched raw GitHub asset links, including the architecture image's enclosing link; links to bundled documents remain local, while source-only `extensions/pi-subagent/DEVELOPMENT.md` links use the matching release on GitHub. Package validation exercises version-only changes and body-only edits to both README sources in a disposable fixture.

The cover image (`pi-subagent-cover.png`, also used as the `pi.image` gallery thumbnail), the model-invoked walkthrough (`pi-subagent-automatic.gif`), and the architecture PNG remain in the source repository but are not included in the npm package. The generated README images and `pi.image` load these assets from the matching release tag, so viewing images requires network access; investigation functionality does not depend on these images. This illustrated demo is not a live model recording; users can also invoke the same bounded investigation manually with `/skill:pi-subagent`.

Before publishing, inspect the generated manifest and dry-run report:

```bash
npm pack --dry-run --json ./packaging/pi-subagent/dist
```

## Trusted Publishing setup

The independent release line began at `0.4.0`. Before future releases, verify npm's actual publisher settings and confirm that the selected version is unused. The transition from `pi-agent-kit` required retiring its release workflow and replacing its trusted-publisher connection; a manifest change alone could not transfer that authority. npm connections cannot be edited in place: if a connection needs to change, create the new one and remove the superseded one, retaining only the intended release connection. Historical kit tags were not imported, and the old npm `0.3.0` remains immutable.

The package publishes through `.github/workflows/npm-publish.yml` without an npm token. Configure its single trusted publisher on the npm package settings page with:

- provider: GitHub Actions;
- organization or user: `MDGChamomile`;
- repository: `pi-subagent`;
- workflow filename: `npm-publish.yml`;
- environment: none;
- allowed action: `npm publish`.

The workflow must exist on the default branch before this relationship is configured. It uses a GitHub-hosted runner, grants only `contents: read` and `id-token: write`, verifies that the stable package version matches the tag and that the tagged commit is on `main`, then reruns typecheck, tests, and package validation before publishing through OIDC.

## Release

1. Set the new immutable version in `manifest.json`. Assembly automatically pins the generated gallery image and README release URLs to the matching version tag; no manual URL version edits are needed. The matching tag must contain the referenced assets and guides before the package is published.
2. Run all verification commands above. Check whether the SHA-pinned actions in `npm-publish.yml` have newer releases than their commented versions, and update the SHA and comment together if so.
3. Merge the release commit into `main` and wait for `validation` to pass.
4. Push the matching `v<version>` tag. The tag triggers `npm-publish.yml`. All `v*` tags are reserved for package releases; a tag that does not exactly match the stable manifest version fails before installation or publishing. Use a non-`v*` tag name for non-package milestones; those tags do not trigger npm publishing.
5. Wait for the publish workflow to pass, then confirm the registry metadata and Pi package manifest:

   ```bash
   npm view @mdgchamomile/pi-subagent name version keywords pi
   ```

6. Create the matching GitHub Release after the npm version is visible publicly.

Never reuse or overwrite a version that has reached the public registry. Do not store registry tokens in the repository or GitHub Actions; Trusted Publishing supplies a short-lived OIDC credential for each release.
