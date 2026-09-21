# Repository migration

Pi Subagent originates in [Pi Agent Kit](https://github.com/MDGChamomile/pi-agent-kit). This repository retains filtered history for the extension, companion skill, packaging, subagent-specific workflows, shared skill validator, license, and design principles. The old `live/extensions/` and `live/skills/` prefixes become `extensions/` and `skills/`; authorship and chronological history are retained, while commit IDs change with the filtered trees. Kit release tags are not product release tags here and are not imported.

Original kit history, releases, and pinned evidence URLs remain authoritative for historical records. Frozen benchmark records, source hashes, old commands, and the archived `packaging/pi-subagent/RELEASE_NOTES.md` are not rewritten as new validation evidence. Historical protocols may require the corresponding old checkout; relocated source is not a substitute for a frozen fixture.

## npm installations

The package remains `@mdgchamomile/pi-subagent`. Existing installations need no rename or second installation. Until an explicitly published release from this repository is available, npm continues to serve the previous kit-published version. Do not install both the npm package and a linked source copy of the same resources.

The independent release line starts at `0.4.0`. Before each release, verify the unused version and update the version-pinned package documentation/assets consistently. The first release also requires replacing the kit's trusted-publisher connection; a manifest change alone does not transfer that authority. Git tags and npm registry metadata, rather than a checked-in version number, establish publication. See [package maintenance](packaging/pi-subagent/DEVELOPMENT.md).

## Source installations

New source installations use `extensions/pi-subagent/` and `skills/pi-subagent/`; see the [source installation instructions](extensions/pi-subagent/README.md#requirements-and-installation).

For an existing kit checkout/symlink installation:

1. Inspect the actual extension and skill paths, including symlinks and local edits. Keep the old checkout available for recovery.
2. Prepare and verify the new checkout before changing either installed resource.
3. Back up local modifications, then replace only the verified extension and companion skill targets together. Do not overlay copies or enable both old and new resources.
4. Restart Pi or reload; confirm exactly one `pi_subagent` tool and one companion skill. A live investigation is optional and consumes provider usage.
5. If resource loading fails, restore the previous pair and reload. Do not remove the old checkout until the transition is verified.

These instructions do not automatically change an installed environment. A repository move also does not remove the old kit sources or transfer npm publisher settings by itself.
