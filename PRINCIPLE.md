# Harness Minimalism: Thin Procedures, Firm Boundaries

- Complex procedures and harnesses introduced to compensate for the limitations of earlier models may instead hinder the autonomy and efficiency of more capable models. Retaining excessive intervention for tasks that models can now perform reliably without it only increases cost and debugging complexity.

- Preserve safety, authorization, and data protection boundaries, but remove procedures whose effectiveness is unclear and begin from a minimal baseline. Then apply an ablation-study approach, adding only the minimum rules needed at points that repeatedly fail in real work.

- Do not enforce unproven procedures by default. Clearly state the objective, essential context, safety boundaries, and success criteria, then allow the model to determine the specific solution path within that scope.

- Minimize the context injected into every session to the project's purpose and core constraints. Rather than indiscriminately adding instructions and examples, first improve the structure of tools and data, and load one-off information or logs only when needed.

- Provide feedback loops, such as test and execution results, that allow the model to verify its own work directly. For actions with a high cost of failure or that are difficult to reverse, do not rely on prompts alone; enforce controls such as least privilege, isolation, and explicit approval at the system layer.

- Retain only harness components that measurably improve quality, cost, or safety over an intervention-free baseline. Routine operating procedures may be revised flexibly, but changes to safety, authorization, or data protection boundaries require clear justification and approval from the harness owner.
