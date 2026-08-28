# Pi Subagent package maintenance

The npm package is assembled from the canonical files under `live/extensions/pi-subagent` and `live/skills/pi-subagent`. Do not edit generated files under `dist/`.

## Verify a package candidate

From the repository root:

```bash
npm --prefix live/extensions/pi-subagent run typecheck
npm --prefix live/extensions/pi-subagent test
npm --prefix live/extensions/pi-subagent run package:check
```

`package:check` rebuilds the ignored `packaging/pi-subagent/dist/` directory, runs `npm pack --dry-run`, verifies the exact tarball file set and Pi resource paths, checks bundled relative Markdown links, and loads the staged package through Pi with an isolated offline configuration.

Before publishing, inspect the generated manifest and dry-run report:

```bash
npm pack --dry-run --json ./packaging/pi-subagent/dist
```

## Release

1. Set the new immutable version in `manifest.json`.
2. Run all verification commands above.
3. Merge the packaging commit and create the matching GitHub tag and release.
4. Rebuild from that tagged commit and publish only the staged directory:

   ```bash
   npm publish ./packaging/pi-subagent/dist --access public
   ```

5. Confirm the registry metadata and Pi package manifest:

   ```bash
   npm view @mdgchamomile/pi-subagent name version keywords pi
   ```

Never reuse or overwrite a version that has reached the public registry. Configure npm Trusted Publishing before automating future releases; do not store registry tokens in the repository.
