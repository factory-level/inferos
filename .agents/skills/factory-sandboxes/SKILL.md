---
name: factory-sandboxes
description: Bring up, check and tear down the software factory's local sandbox environments from an InferOS checkout - pnpm local factory up dev|infra|verify|stage-probe, status, doctor, down and stage-smoke; the InferOps stack in its own checkout with bun, floci-gcp reuse, security/perf tool images, the stage probe and scripted grokbot stage smoke (release graph node 10) against a remote or loopback stage, smoke credentials by name, and the no-cloud-credentials rule. Use before any factory pipeline run, coding-runner dispatch, stage smoke or perf/security work that needs a running local stack, and whenever doctor reports FAIL.
---

# Factory sandboxes

The factory is the skills agents consume plus the sandboxes they run in; InferOS is the vessel that hosts the sandboxes. A sandbox is a credential-free set of local services. Architecture: `docs/architecture/factory.md`. Code: `scripts/local/factory.ts` (routed through `scripts/local/lifecycle.ts`).

| Sandbox | Runs | Extra checks |
| --- | --- | --- |
| `dev` | InferOS `pnpm run-local` (this checkout, :8787) + InferOps `bun run dev up --docker --seed` in **its own checkout**, or with `--inferops-image` the built InferOps API image (no KMS) | — |
| `infra` | `dev` + floci-gcp (reuses whatever answers `127.0.0.1:<port>/health`, else starts `floci/floci-gcp:latest` published on 127.0.0.1 only) | wrangler, docker |
| `verify` | `dev` | wrangler, docker, the six tool images (Semgrep, gitleaks, OSV-Scanner, Trivy, ZAP, Artillery) |
| `stage-probe` | nothing; targets the stage `FACTORY_STAGE_URL` (or `--stage-url`) names | the stage's smoke credentials are present **by name only**; the stage answers; remote: unauthenticated `/` redirects to Cloudflare Access; loopback: InferOS and its connected InferOps healthy, InferOps in stub auth; docker + the Artillery image |

## Commands

```bash
pnpm local factory up <sandbox> [--inferops-dir DIR] [--inferops-image REF] [--inferops-connect] [--timeout SECONDS]   # start, then wait for health
pnpm local factory doctor [sandbox]     # one READY/FAIL line per check + health JSON per service
pnpm local factory status               # the recorded sandbox's services only
pnpm local factory down                 # stop exactly what `up` started
pnpm local factory stage-smoke [--stage-url URL]   # doctor stage-probe, then (only if READY) node 10's smoke
```

Add `--json` for one JSON object on stdout. Exit 0 means every check is READY, 1 a FAIL, 2 a usage error.

Configuration (environment): `FACTORY_INFEROPS_DIR` (the InferOps checkout; or `--inferops-dir`), `FACTORY_INFEROPS_OFFSET` (that checkout's worktree offset; API at 8080 + offset x 100) or `FACTORY_INFEROPS_URL`, `FACTORY_INFEROPS_IMAGE` (or `--inferops-image`), `FACTORY_INFEROPS_DB` (`inferos_factory`), `FACTORY_PG_ADMIN_URL` (the local compose Postgres), `FACTORY_FLOCI_PORT` (4588), `FACTORY_FLOCI_IMAGE`. InferOS's own port follows `--port`/`VITE_BACKEND_HOST` like the rest of `pnpm local`.

## Procedure

1. Unset every cloud, model-provider and prod credential in the shell first. `up` refuses and `doctor` FAILs while one is present (`credentials` names them; values are never printed). Do not rename a variable to dodge the check; start a clean shell.
2. Use a separate InferOps worktree with its own offset (the `new-worktree` skill in that repo). Never point `--inferops-dir` at a checkout whose `config/local.json` holds cloud keys, and never run InferOps commands from this directory: the factory runs `bun` in that checkout with pnpm's script variables stripped.
3. `pnpm local factory up dev`, then `pnpm local factory doctor`. Fix each FAIL line at its cause. A `service:inferops` FAIL saying the checkout "is not bootstrapped" means InferOps needs `bun run bootstrap`, which decrypts its development secrets; that is a person's step, not an agent's. Use image mode instead.
   - **Image mode** (no KMS): build the image with the InferOps CI (`bun ci/pipeline.ts --target=local` in that checkout; its `build` node records the digest in `.factory/runs/<id>/state.json` `ctx.digest`, the registry is `127.0.0.1:<5000 + offset x 100>`), then `pnpm local factory up dev --inferops-dir <that checkout> --inferops-image 127.0.0.1:<port>/services/inferlab@sha256:<digest>`. The checkout must be at the image's commit: migrate and seed run there, into the factory's own database (`FACTORY_INFEROPS_DB`, recreated on every `up`). The API runs in stub auth (`inferops login --persona owner` works against it); it serves no web clients and no worker. Read `.factory/logs/inferops.log` when it FAILs.
4. Run the work (for example the `factory-ci` skill), then `pnpm local factory down`.
5. **Stage smoke (release graph node 10).** In a shell holding only `PATH`/`HOME`/`USER`/`LANG`/`TERM`, `FACTORY_STAGE_URL` and the stage's smoke variables:
   - Remote stage (`https://dev-os...`): `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `GROKBOT_PERSONA_USER`, `GROKBOT_PERSONA_PASSWORD`, `GROKBOT_VIEWER_USER`.
   - Loopback stage (the `dev` sandbox standing in): `pnpm canvas init` (saved canvases) and `pnpm local factory up dev --inferops-image <digest> --inferops-connect` from the clean shell first; then `FACTORY_STAGE_URL=<that InferOS origin>`, `GROKBOT_PERSONA_USER=grokbot-operator`, `GROKBOT_VIEWER_USER=grokbot-viewer` (no Access, stub personas, no password). The connected InferOps is found from `.factory/sandbox.json` (or `FACTORY_INFEROPS_URL`).
   - `pnpm local factory doctor stage-probe` must be all READY, then `pnpm local factory stage-smoke` (or `node scripts/ci/stage-smoke.ts --part flow|probe`). Evidence is `.factory/runs/<id>/stage-smoke/` (`smoke.json` oracles, screenshots, `probe.json`, `result.json`). Report each oracle as it reads there; a FAIL there is the gate failing, not a flake to retry away. The smoke moves one issue and moves it back, and rejects requests an interrupted run left pending. `down` leaves running anything the factory reused (another process's floci, an InferOps already answering), and says so.

## Guardrails

- Evidence, not belief: report the doctor lines you saw. A service that the doctor shows FAIL is not "up", and a sandbox whose InferOps check FAILs has not proven InferOps.
- A port held by a process this checkout did not start is reported, never probed as the stack and never signalled.
- `stage-probe` is the only sandbox that may hold the smoke credentials (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `GROKBOT_PERSONA_USER`, `GROKBOT_PERSONA_PASSWORD`, `GROKBOT_VIEWER_USER`); in any other sandbox they are a credentials FAIL, so keep the smoke shell separate from the one that runs `up dev`. Never echo, log or paste their values; the smoke passes them to its container by name.
- Do not weaken a loopback stage into a remote one or the reverse to make doctor green (for example plain `http://` to a remote host): the credential set follows the stage's kind.
- Docker: ports on 127.0.0.1 only, never mount `/var/run/docker.sock`. Image mode mounts nothing and passes no credential; never add a secret layer or `GOOGLE_APPLICATION_CREDENTIALS` to make an image boot.
- InferOS in `dev` reads boards from the InferOps gatekeeper's mock unless `up` is given `--inferops-connect` (or `INFEROPS_BASE_URL` and a sign-in are set in the shell that starts it); `factory status --json` records `inferos.inferops` as `mock` or `connected`. With `--inferops-connect` people sign in through the sandbox's InferOps ("Continue with InferOps"; in image mode a stub persona such as `grokbot-operator`), each with their own session. Do not report the mock as InferOps.
- State lives in `.factory/sandbox.json` and logs in `.factory/logs/` (gitignored). Do not edit the state file by hand; `down` reads it.
