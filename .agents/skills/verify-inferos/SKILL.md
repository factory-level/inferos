---
name: verify-inferos
description: Verify an InferOS wrapper repository - configuration check, doctor preflight, local stack status and the agent-view board read - as one machine-readable JSON report. Use after setup, after every upgrade or recovery, and whenever asked whether a wrapper works.
---

# Verify an InferOS wrapper

Run from the wrapper root (it has `inferos.config.json` and `.inferos/runtime.ts`).

1. `pnpm inferos verify`. It prints one JSON object and exits 0 when every check passed, 1 when one failed and 2 on a usage error.
2. Read `checks[]`. Each has `name` (`check`, `doctor`, `local-status`, `local-verify`), `status` (`pass`, `fail`, `skipped`) and `reasons`. `failures` lists the failed names.
   - `check`: the pin, gitlink and configuration agree, and the pin supports the schema version and every enabled capability.
   - `doctor`: local prerequisites (Node, pnpm, dependencies, port, fixture, settings). A `dependencies` failure means `pnpm run setup` has not run.
   - `local-status` and `local-verify` run only while the stack is up (`pnpm local start`, then `pnpm local seed`). They are `skipped` otherwise, including when the port answers but the listener is not this wrapper's stack (the reason starts with `port-in-use-by-other`; another server holds `local.port`, and `local verify` is never run against it). Do not report that as a running stack: stop the other process or run `pnpm inferos recover ports`. Add `--live` when the task requires live evidence, so a stopped stack fails instead.
3. Fix what a failing check names and rerun. Port, configuration, fixture and stale-state failures have bounded repairs in the `recover-inferos` skill.
4. Report the JSON (or its `failures` and `reasons`) as evidence. Never paste secret values; the report carries only names and presence.

A passing verify is local evidence only. It does not prove cloud parity or a live InferOps connection unless `local-status` reports `inferops.mode: "live"`.
