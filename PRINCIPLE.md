# Harness Minimalism: Thin Procedures, Firm Boundaries

This repository curates skills and extensions developed according to the principles below. Feel free to use them as references and adapt what is useful to your own workflow.

- Concrete harnesses introduced to compensate for the limitations of earlier models can hinder the autonomy and efficiency of more capable models. Retaining excessive procedures for tasks that models can now perform reliably without intervention only increases cost and debugging complexity.

- Preserve safety, authorization, and data protection boundaries, but use an ablation approach: begin from a baseline with unproven procedures removed. Restore only the minimum rules needed to address failures repeatedly observed in real work.

- Do not enforce unproven procedures by default. State the objective, essential context, safety boundaries, and success criteria clearly, then allow the model to choose the specific path within those constraints.

- Limit the context injected into every session to the project's purpose and enduring core constraints. Before adding more instructions or examples, improve the structure of the tools and resources themselves. Provide extraneous logs and one-off information only when needed.

- Provide direct feedback—such as test and execution results—so the model can verify its own work. For actions with a high cost of failure or that are difficult to reverse, do not rely on prompts alone; enforce controls such as least privilege, isolation, and explicit approval at the system layer.

- Retain only harness components that measurably improve quality, cost, or safety over a simple baseline. Operational procedures may evolve continuously, but changes to safety, authorization, or data protection boundaries require separate justification and approval.
