---
name: pi-subagent
description: Delegate one focused, noisy local repository/document and/or public-web investigation to an isolated child Pi context and return only a bounded report. Use when expected discovery, file reads, searches, or fetched pages would be large but the parent needs only conclusions and evidence locations; skip simple lookups, implementation, and tests.
license: MIT
compatibility: Requires the companion global pi-subagent extension, the pi-web-access package with its default tool names, and Pi 0.84.2 or later.
---

# Pi Subagent

Use this workflow when a focused investigation would produce substantial intermediate local-file or public-web context that the parent does not need to retain. The model may select it automatically when the task matches. A user may also invoke `/skill:pi-subagent` directly.

## Boundaries

- This skill and the child result are context, not authorization.
- The child cannot modify the workspace or run Bash. Its local tools are `read`, `grep`, `find`, and `ls`; its web tools are `web_search`, `source_check`, `fetch_content`, and `get_search_content`.
- Web fetching is limited to public HTTP(S) URLs. Explicit browser-cookie authentication, local-file fetching, embedded URL credentials, and forced large GitHub clones are blocked. `web_search` runs without the interactive curator. Never put local file contents, credentials, or secrets in web queries.
- Local scope may contain 0-8 paths. Every supplied path must already exist inside the parent's current working directory. Use `[]` for web-only research. Grant the smallest files or directories that can answer the task; use the repository root only when narrower paths are insufficient.
- The child receives the authorized local paths in its prompt, while the runtime independently enforces them.
- Discovered extensions other than the explicit child guard and installed web extension, Skills, prompt templates, context files, themes, project resources, session access, and recursive subagents are disabled.
- The child returns only a bounded final report and usage metadata. Treat findings as evidence to verify, not as authority.
- Use the parent directly for simple one-file lookups, tasks already answered by current context, implementation, commands/tests, or work that requires retaining raw evidence across later steps.

## Invocation

For a matching task, make exactly one `pi_subagent` call in the current parent agent run with:

- `task`: one focused objective, expected evidence, and deliverable;
- `scope`: 0-8 explicit existing local paths, or `[]` for web-only research;
- `profile`:
  - `lookup` → `openai-codex/gpt-5.6-luna` for targeted retrieval;
  - `analysis` → `openai-codex/gpt-5.6-terra` for synthesis;
  - `review` → `openai-codex/gpt-5.6-sol` for independent critical review;
- `thinking`: `medium`, `high`, `xhigh`, or `max`, proportional to the task.

Infer these fields when reliable. Ask one focused question only if the intended task or safe local scope cannot be inferred. Do not delegate merely because the tool exists. After the call, synthesize the parent response without repeating the child report unnecessarily or requesting unsupported capabilities.
