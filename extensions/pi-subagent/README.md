# Pi Subagent

A foreground, model-invocable, single-run Pi subagent for isolating noisy local-file and public-web investigation from the parent context.

## Requirements

- Node.js 22.19 or newer
- Pi coding agent (tested with 0.84.2)
- `pi-web-access` (tested with 0.24.1)
- Access to the configured `openai-codex/gpt-5.6-luna`, `terra`, and `sol` models

## Install from a checkout

```bash
git clone https://github.com/MDGChamomile/pi-agent-kit.git
cd pi-agent-kit
pi install npm:pi-web-access
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills
ln -s "$PWD/live/extensions/pi-subagent" ~/.pi/agent/extensions/pi-subagent
ln -s "$PWD/live/skills/pi-subagent" ~/.pi/agent/skills/pi-subagent
```

Restart Pi or run `/reload` after installation.

## Contract

- Activation: the model may select the visible `pi-subagent` skill or `pi_subagent` tool when a task matches; users may still invoke `/skill:pi-subagent`
- Runs: one successful child call per parent agent run; one corrected retry is allowed only after preflight validation failure
- Child process: one ephemeral `pi --mode json --print --no-session` process
- Capabilities: `local` loads only Pi-owned `read`, `grep`, `find`, `ls`; `web` loads only web tools; `both` loads both sets
- Web tools: `web_search`, `source_check`, `fetch_content`, `get_search_content` from the package-declared entry point of the installed `pi-web-access` package
- Local scope: 0-8 existing files or directories inside the parent cwd; `local`/`both` require a non-empty scope and `web` requires an empty scope
- Web boundary: HTTP(S) under the installed web extension's SSRF protection policy; no local-file fetch, explicit browser-cookie auth, embedded URL credentials, or forced large GitHub clone; search curator is disabled
- Resources disabled: all discovered extensions, Skills, prompt templates, context files, themes, and project trust. Only the child guard and resolved web extension are explicitly loaded
- Readiness: the parent accepts a report only after the child guard validates policy and tool ownership and publishes a private readiness marker
- Return: control-character-sanitized final assistant report capped at 12 KiB plus bounded usage metadata
- Timeout: 15 minutes

Profiles map to fixed models:

- `lookup` → `openai-codex/gpt-5.6-luna`
- `analysis` → `openai-codex/gpt-5.6-terra`
- `review` → `openai-codex/gpt-5.6-sol`

Child thinking levels are `low`, `medium`, `high`, `xhigh`, and `max`.

The companion progressively disclosed workflow is `../../skills/pi-subagent/SKILL.md`.

## Security boundary

The child guard canonicalizes every requested local path and blocks paths outside the explicit scope, including lexical, absolute, and symlink escapes. It independently checks that each enabled local tool is Pi-owned and each enabled web tool comes from the package-declared entry point of the installed `pi-web-access` package. The web extension loads before the guard so the guard is the final `tool_call` policy handler. Local-only runs do not resolve or load the web extension. If policy or ownership validation fails, no readiness marker is published and the parent rejects any assistant text the child may still produce.

Web access is deliberately narrower than the full `pi-web-access` surface and remains subject to that extension's SSRF protection policy. The guard rejects local paths and `file:` URLs, explicit authenticated browser-cookie fetches, URL credentials, and forced oversized clones. The child prompt also forbids putting local file contents or secrets in web queries. The web extension may still make external provider requests and maintain its documented bounded cache or temporary files. Authorized local file contents, search queries, fetched public pages, and the final report are sent to the applicable model or search providers.

This is an application-level capability boundary, not an OS or network sandbox. The child and the trusted web extension still run as the current user. Do not use it for untrusted workloads requiring host isolation or for secrets that must not be sent to configured providers.

The extension does not support workspace writes, Bash, tests, session-history access, project-controlled resources, parallelism, recursion, background runs, or child-session persistence.

## Verification

```bash
npm --prefix live/extensions/pi-subagent test
```

Before adoption, a bounded live smoke test should verify model-selected activation, one-call enforcement, an allowed local read, an out-of-scope denial, a public web search/fetch, local-file and auth-fetch denial, bounded output, and temporary-file cleanup.
