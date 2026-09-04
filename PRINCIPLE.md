# Harness Minimalism: Thin Procedures, Firm Boundaries

> “Every component in a harness encodes an assumption about what the model can't do on its own, and those assumptions are worth stress testing, both because they may be incorrect, and because they can quickly go stale as models improve.”
>
> — Anthropic, [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)

> “Find the simplest solution possible, and only increase complexity when needed.”
>
> — Anthropic, [Building effective agents](https://www.anthropic.com/research/building-effective-agents)

- Complex procedures and harnesses introduced to compensate for the limitations of earlier models may instead hinder the autonomy and efficiency of more capable models. Retaining excessive intervention for tasks that models can now perform reliably without it only increases cost and debugging complexity.

- Start from a minimal baseline that retains the objective, essential context, success criteria, and safety, authorization, and data protection boundaries. Add other procedures only to the minimum extent needed to address failures that recur and can be reproduced in representative evaluations or real work. However, use evidence-based system controls to prevent risks with a high cost of failure or that are difficult to reverse, even before incidents recur.

- Do not enforce unvalidated solution procedures by default. Within the minimal baseline, leave the specific solution path to the model's judgment and add task-specific context only when needed.

- Minimize the context injected into every session to the project's purpose and core constraints. Rather than indiscriminately adding instructions and examples, first improve the structure of tools and data, and load one-off information or logs only when needed.

- Provide feedback loops, such as test and execution results, that allow the model to verify its own work directly. For actions with a high cost of failure or that are difficult to reverse, do not rely on prompts alone; enforce controls such as least privilege, isolation, and explicit approval at the system layer.

- If a temporary procedure is needed before it can be measured, record its hypothesis, scope, expected benefits and tradeoffs, review date, and removal criteria. Do not present that decision as a validated conclusion.

- Retain only harness components that measurably improve quality, cost and latency, safety, or operational complexity over an intervention-free baseline. Routine operating procedures may be revised flexibly, but changes to safety, authorization, or data protection boundaries require clear justification and approval from the harness owner.
