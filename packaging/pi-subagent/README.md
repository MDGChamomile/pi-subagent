# Pi Subagent

A focused Pi package containing the `pi_subagent` extension and its companion progressively disclosed investigation skill.

The extension runs bounded, read-only local-file or web investigations in an ephemeral child Pi process and returns only the final answer to the parent context. The skill decides when and how to delegate; the extension enforces scope, provenance, resource budgets, process lifecycle, telemetry, and output boundaries.

## Install

Pi 0.84.2 or later is required.

```bash
pi install npm:@mdgchamomile/pi-subagent
```

Local investigations work with the package alone. Web investigations additionally require the exact reviewed web extension version:

```bash
pi install npm:pi-web-access@v0.27.0
```

Restart Pi or run `/reload`. The model can then select the skill automatically, or you can invoke `/skill:pi-subagent`.

## Documentation and security

Read the [extension guide](https://github.com/MDGChamomile/pi-agent-kit/blob/v0.2.2/live/extensions/pi-subagent/README.md) for the complete installation, runtime, data-flow, and security contract. The concise [skill guide](https://github.com/MDGChamomile/pi-agent-kit/blob/v0.2.2/live/skills/pi-subagent/README.md) explains when delegation is appropriate.

The child is read-only, but this is an application-level capability boundary rather than an OS or credential-isolated sandbox. Extensions execute with the current user's system permissions. Review the package source and its documented trust assumptions before installing it.

Source: [MDGChamomile/pi-agent-kit](https://github.com/MDGChamomile/pi-agent-kit)
