# Migration

## v0.8.0

### Minimum Pi version

Pi Subagent now requires Pi 1.0.0 or later, raised from 0.99.1. Development dependencies and CI pin Pi 1.0.0. Update Pi before installing a release that includes this change; there is no compatibility path for older Pi versions.

### Legacy preset arguments

Calls must use the current `preset` names: `lookup-standard`, `analysis-standard`, or `review-standard`. The runtime no longer translates the former separate `profile`/`thinking` arguments or the balanced/deep/exhaustive preset names; such calls, including ones replayed from older stored sessions, now fail schema validation instead of running.
