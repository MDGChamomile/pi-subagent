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
- The child is read-only and cannot run Bash. Child startup is offline, and a dedicated liveness pipe terminates the POSIX child process group (or the child process itself on Windows) if the parent exits abruptly. Local `grep` requires an installed `rg` and `find` requires `fd` or `fdfind`; missing binaries fail instead of being downloaded. Never put local file contents, credentials, or secrets in web queries.

## Invoke

Use one `pi_subagent` call by default. Use up to three calls per parent agent run only when the investigation can be split into distinct, independent research tracks that materially benefit from parallel work. A corrected retry is allowed only after preflight validation fails.

Fill the tool arguments according to its schema, applying these choices:

- Give each `task` one non-overlapping objective. Request only a concise conclusion, up to 10 material findings with evidence locations, material alternatives, uncertainties, and coverage gaps—never a chronological transcript, exhaustive file summary, or raw tool output. When using multiple calls, issue independent calls together so they can run in parallel and leave synthesis to the parent.
- Treat `scope` as an authorization boundary. Use 0-8 existing paths inside the current working directory, broad enough to contain the needed evidence. `local` and `both` require at least one path; `web` requires `[]`.
- Use the least capable `capability` and one validated `preset`: `lookup-standard` (Luna/low), `lookup-balanced` (Luna/medium), or `lookup-deep` (Luna/high) for bounded fact-finding; `analysis-standard` (Terra/high) or `analysis-deep` (Terra/xhigh) for synthesis and causal comparison; `review-standard` (Sol/high), `review-deep` (Sol/xhigh), or `review-exhaustive` (Sol/max) for adversarial review. Choose depth according to task difficulty; the main model's thinking level is never changed.
- Infer arguments when reliable. Ask one focused question only when the task or safe scope cannot be inferred.

After a successful child report, treat it and its evidence locations as the working investigation result. Do not repeat broad reads, searches, or repository-wide inspection already delegated. Verify only claims that are decisive for the answer or a subsequent mutation, using a few targeted parent calls, then synthesize without restating the report. If later implementation needs broad knowledge of the same files, keep that investigation in the parent instead of delegating it. If the child fails after starting, continue in the parent only when feasible and report the verification gap.
