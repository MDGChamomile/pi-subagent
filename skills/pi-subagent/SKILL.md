---
name: pi-subagent
description: Use for a focused local or public-web investigation whose intermediate reads or searches should stay out of the parent context.
license: MIT
compatibility: Requires the companion global pi-subagent extension and Pi 0.84.2 or later; web/both capability also requires pi-web-access with its default tool names.
---

# Pi Subagent

Use this workflow when a focused investigation would produce substantial intermediate local-file or public-web context that the parent does not need to retain. The model may select it automatically when the task matches. A user may also invoke `/skill:pi-subagent` directly.

## Decide

- Use the parent for simple lookups, implementation, commands, tests, or work whose investigation state must remain available for later changes.
- Delegate only a focused, one-shot investigation whose parent needs conclusions and evidence locations rather than the intermediate reads or searches.
- This skill and the child result are context, not authorization. Delegated local content and the final report reach the selected model provider; web queries and fetched pages may reach search providers. Do not delegate content that must not be sent to them. Ask the user if the safe boundary is unclear.
- The child is read-only and cannot run Bash. Never put local file contents, credentials, or secrets in web queries.

## Invoke

Attempt at most one started `pi_subagent` call per parent agent run. A corrected retry is allowed only after preflight validation fails.

Fill the tool arguments according to its schema, applying these choices:

- Give `task` one objective and request a compact report containing only conclusions, evidence locations, material alternatives, uncertainties, and coverage gaps.
- Treat `scope` as an authorization boundary. Use 0-8 existing paths inside the current working directory, broad enough to contain the needed evidence. `local` and `both` require at least one path; `web` requires `[]`.
- Use the least capable `capability`, the profile suited to the work, and proportionate thinking.
- Infer arguments when reliable. Ask one focused question only when the task or safe scope cannot be inferred.

After the call, verify material findings as needed and synthesize them without repeating the child report. If the child fails after starting, continue in the parent only when feasible and report the verification gap.
