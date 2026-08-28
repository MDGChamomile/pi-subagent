---
name: pi-subagent
description: Use for a focused local-file or web investigation whose intermediate reads or searches should stay out of the parent context.
license: MIT
compatibility: Requires the companion global pi-subagent extension and Pi 0.84.2 or later; web capability also requires pi-web-access v0.26.0 with its default tool names.
---

# Pi Subagent

Use this workflow when a focused investigation would produce substantial intermediate local-file or web context that the parent does not need to retain. The model may select it automatically when the task matches. A user may also invoke `/skill:pi-subagent` directly.

## Decide

- Use the parent for simple lookups, implementation, commands, tests, or work whose investigation state must remain available for later changes.
- Keep post-edit validation in the parent when the parent already holds the changed files and evidence or may need to make follow-up fixes; do not delegate the final diff, audit, test, or retrieval gate merely for an extra review pass.
- Delegate only a focused, one-shot investigation whose parent needs conclusions and evidence locations rather than the intermediate reads or searches.
- This skill and the child result are context, not authorization. Delegated local content and the final answer reach the selected model provider; web queries and fetched pages may reach search providers. Do not delegate content that must not be sent to them. Ask the user if the safe boundary is unclear.
- The child is read-only and cannot run Bash. Local and web access never coexist in one child. The `web` capability selects web research tools; it is not a credential-isolated sandbox, and the trusted web extension may use host credentials. Never put local file contents, credentials, or secrets in web tasks or queries.
- Each child has a lifetime tool budget. A one-time soft warning asks it to gather only essential missing evidence; a hard tool-call or web query/fetch limit disables further tools and returns the best available answer as `partial` with a tool-budget reason. Denied calls count toward the tool-call limit.

## Invoke

Use one `pi_subagent` call by default. Use up to three calls per parent agent run only when the investigation can be split into distinct, independent research tracks that materially benefit from parallel work. Separate local and web calls each count toward this limit. A corrected retry is allowed only after preflight validation fails.

Fill the tool arguments according to its schema, applying these choices:

- Give each `task` one non-overlapping objective and request a concise conclusion with evidence locations and relevant uncertainties, not a transcript or raw output. When local and public evidence are both needed, use separate `local` and `web` calls and leave cross-source synthesis to the parent. Issue independent calls together so they can run in parallel.
- Treat `scope` as an authorization boundary. Use 0-8 existing paths inside the current working directory, broad enough to contain the needed evidence. `local` requires at least one path; `web` requires `[]`.
- Use the least capable `capability` and the matching standard `preset`: `lookup-standard` (Luna/low) for bounded fact-finding, `analysis-standard` (Terra/medium) for synthesis and causal comparison, or `review-standard` (Sol/medium) for adversarial review. The main model's thinking level is never changed.
- Infer arguments when reliable. Ask one focused question only when the task or safe scope cannot be inferred.

After a complete child result, treat it and its evidence locations as the working investigation result. A result marked `partial` reached the investigation deadline: use its supported findings, explicitly disclose the time limit and coverage gaps, and do not present it as complete. Do not repeat broad reads, searches, or repository-wide inspection already delegated. Verify only claims that are decisive for the answer or a subsequent mutation, using a few targeted parent calls, then synthesize without restating the result. If later implementation needs broad knowledge of the same files, keep that investigation in the parent instead of delegating it. If the child fails without a final answer after starting, continue in the parent only when feasible and report the verification gap.
