---
title: Software factory sandboxes and local CI
covers:
  - scripts/local/factory.ts
  - scripts/local/factory.test.ts
  - scripts/local/lifecycle.ts
  - scripts/ci
  - load
  - .github/workflows/ci.yml
  - .github/workflows/_verify.yml
  - .github/actions
  - .agents/skills/factory-sandboxes
  - .agents/skills/factory-ci
updated: 2026-10-28
---

# Software factory sandboxes and local CI

## Overview

The factory is the skills agents consume plus the sandbox environments they run in ([design](../design/factory.md), tracking [#285](https://github.com/factory-level/inferos/issues/285)). This checkout is the vessel: `pnpm local factory` brings the sandboxes up and down, and `scripts/ci/pipeline.ts --target=local` runs the InferOS side of release-graph nodes 1-5, 7 and 8 against them, writing evidence under `.factory/runs/<run-id>/`. GitHub Actions is a consumer of the same scripts through a reusable workflow and thin composite actions. Nothing here deploys: there is no Cloudflare account in any step.

## Components

| Path | Responsibility |
| --- | --- |
| `scripts/local/factory.ts` | `pnpm local factory up <dev\|infra\|verify\|stage-probe>\|status\|doctor [sandbox]\|down`, dispatched from `lifecycle.ts` before its own parsing. Sandbox table, credential guard, health probes, start/stop of what it started, state in `.factory/sandbox.json`. |
| `scripts/ci/lib.ts` | Shared node plumbing: run ids (`local-<utc>-<sha7>`), `--run-id/--part/--base/--target`, evidence directory, teeing `exec`, `result.json`, the GHA step summary line, and the Docker argument rules. |
| `scripts/ci/verify.ts` | Node 1. Parts `all` (`pnpm lint`, `pnpm test`, `pnpm docs:check`), and CI's `lint`, `build`, `test`, `docs`; a failed `pnpm test` also runs `scripts/vp/last-run-report.ts`. |
| `scripts/ci/security.ts` | Node 2. Semgrep (`p/default`), gitleaks (commits since `--base`, plus a copy of changed/untracked working-tree files), OSV-Scanner (`pnpm-lock.yaml`), Trivy fs (vuln, misconfig, secret). Normalized findings gated against `security-baseline.json`. |
| `scripts/ci/build.ts` | Node 3. `scripts/release/build-release.ts` (wrangler dry-run bundles of every deployable Worker + Access-mode frontend + manifest) with Cloudflare variables stripped; records the manifest sha256. |
| `scripts/ci/local-deploy.ts` | Node 5 (InferOS half). Reuses or starts this checkout's `run-local` stack, restarts a factory-started stack that predates this run's build, gates on every Worker answering, `/` serving the shell and `pnpm local seed`; records InferOps `/health/ready` ungated. |
| `scripts/ci/bindings.ts` | Node 4 (InferOS half). Every binding in each committed `wrangler.jsonc` must appear in the local run's generated `wrangler.dev.jsonc` and resolve through Wrangler's `getPlatformProxy({ configPath })`, or (for `worker_loaders`) through its running Worker; every Worker must answer through the router. |
| `scripts/ci/dast.ts` | Node 7. ZAP baseline against the local router; gate on high-risk alerts new against `dast-baseline.json`. |
| `scripts/ci/perf.ts`, `load/` | Node 8. Artillery HTTP load (`inferos-http.yml`) and the Playwright engine (`inferos-browser.yml` + `inferos-browser.mjs`: shell boot, sign-in, the seeded mock-board workspace) with Web Vitals; gate is Artillery's `ensure`, enabled through `plugins.ensure` (without it Artillery 2 ignores the block and exits 0), and the node also fails when a log lacks Artillery's `Checks:` section. |
| `scripts/ci/pipeline.ts` | The orchestrator: credential refusal, node selection (`--only/--skip`), one child per node, fail-fast (`--keep-going`), `state.json`. `pnpm factory:ci` is `--target=local`. |
| `scripts/ci/security-baseline.json`, `dast-baseline.json` | Reviewed accepted findings by fingerprint / ZAP plugin id. |
| `.github/workflows/_verify.yml`, `.github/actions/{setup,verify}` | Node 1 as a `workflow_call` workflow (jobs Lint and Build and test, unchanged commands) built from a toolchain setup action and an action that runs `scripts/ci/verify.ts --part <p>`. `ci.yml` keeps its triggers and concurrency and calls it. |
| `.agents/skills/factory-sandboxes`, `factory-ci` | Agent SOPs with `evals/evals.json`. |

## Data and Control Flow

**Sandboxes.** `up` first checks the environment by name: model-provider keys through `runner.ts`'s `providerVariables`, cloud/deploy keys (`AWS_*` keys, `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDFLARE_API_TOKEN`, `PULUMI_ACCESS_TOKEN`, ...) and, outside `stage-probe`, the smoke credentials (`CF_ACCESS_CLIENT_ID/SECRET`, `GROKBOT_PERSONA_USER/PASSWORD`). Any hit refuses `up` and FAILs `doctor`; values never enter a report. It then starts, per sandbox:

- `inferos`: adopts this checkout's recorded dev server (`stackOwnership` from `stack.ts`), refuses a foreign listener, else launches `scripts/run-local.ts` detached (own process group, log `.factory/logs/inferos.log`). Health: every configured Worker through the router (`probeWorkers`) and `/` answering 200 (a router whose asset manifest went stale answers 404).
- `inferops`: adopted when `/health/ready` already answers 200 with a ready body (the route answers 200 even while Postgres is down, so a body `status` other than `ok`/`up`/`ready` is a FAIL); else one of two modes, each in `FACTORY_INFEROPS_DIR` with pnpm's script variables (`npm_*`, `PNPM_*`, `INIT_CWD`, `NODE_OPTIONS`) removed. URL `FACTORY_INFEROPS_URL`, else `8080 + FACTORY_INFEROPS_OFFSET x 100`.
  - **Checkout mode** (default): `bun run dev up --docker --seed` detached. Needs a bootstrapped checkout, which decrypts that checkout's development secrets.
  - **Image mode** (`--inferops-image REF` or `FACTORY_INFEROPS_IMAGE`; a digest reference from the InferOps CI's local registry is best): the way the InferOps CI's `local-deploy` node runs the image, so nothing is KMS-decrypted. Through `deps.runIn` in the checkout (which must be at the image's commit, since the image carries no migrations): `DROP`/`CREATE DATABASE <FACTORY_INFEROPS_DB>` (default `inferos_factory`) over `FACTORY_PG_ADMIN_URL` (default the InferOps compose Postgres, `postgres://postgres:postgres@localhost:5432/postgres`), `psql -f db/init-db.sql`, `bunx turbo run migrate`, `seed` and `seed:reserved` (throwaway probe keys). Then `docker run -d --name inferos-factory-inferops --add-host host.docker.internal:host-gateway -p 127.0.0.1:<port>:8080` with `NODE_CONFIG_ENV=factory` (no secret layer exists for it, so the API boots on `default.js` in stub auth), `NODE_ENV=production` and the database URL; no volume, no Docker socket. Every step's output goes to `.factory/logs/inferops.log`, and so does the container's log tail when it is not ready in time. A refused image reference is a usage error. `down` removes the container; the database stays until the next `up` recreates it.
- **Connect** (`--inferops-connect`, `up` only): InferOS's `run-local` is launched with `INFERLAB_AUTH_ORIGIN` and `INFEROPS_BASE_URL` both set to the sandbox's InferOps origin and `inferops` added to `AUTH_GATEKEEPERS` (`inferopsConnectEnv`), so the login page offers "Continue with InferOps" and every person connects with their own InferLab session; no stopgap token is set. Refused (usage error) unless that InferOps is `http` on loopback. In image mode the container also gets `NODE_CONFIG={"auth":{"sso":{"inferosOrigins":["<InferOS origin>"]}}}` (`inferopsSsoLayer`), registering this InferOS as the `inferos` client's redirect origin (InferOps' default allows only `http://localhost:8787`); against the image's stub auth the `/authorize` page offers the reserved test personas (`grokbot-operator` and others). An InferOS that is already running is adopted unchanged and the flag is reported as not applied (stop it first). The state records `inferos.inferops: "mock" | "connected"`. A second `up` keeps the ownership of an InferOps container an earlier `up` started, so InferOS can be restarted with new settings (say `CODING_WORKBENCH_ENABLED`/`CODING_WORKBENCH_REPOS` from the shell) without recreating the database, and `down` still removes it. Checkout mode does not set `inferosOrigins`: that checkout's own config decides.
- `floci`: adopted when `127.0.0.1:<FACTORY_FLOCI_PORT>/health` answers 200 (the existing `floci-spike` container); else `docker run -d --name inferos-factory-floci -p 127.0.0.1:<port>:4588`.

`up` polls until every started service is healthy, a launched process dies (its log is named), or `--timeout` passes. `doctor` adds tool checks (`wrangler`; `docker`; for `verify` the six images) and, for `stage-probe`, the smoke credentials' presence. `down` signals each launched process group that is still alive (SIGTERM, then SIGKILL after 30 s; a recorded pid that already exited is reported, never signalled, since its group id may have been reused), removes a container only if it created it, and reports what it left running.

**Pipeline.** `pipeline.ts` refuses on any forbidden credential, then runs `verify → security → build → local-deploy → bindings → dast → perf` as `node scripts/ci/<node>.ts --run-id <id> --target=<t>`. Each command's output is teed to its log; a command is judged by its exit code, with a 5 s drain after exit, because an orphaned grandchild (a vitest worker) can hold the pipes open indefinitely. Each node writes `<node>/result.json` (gate text, commands with exit codes, durations and logs, details) and exits 0 only on a passed gate; the orchestrator records `state.json` (`nodes`, `passes`, `skipped`, `ok`). `local-deploy` precedes `bindings`, `dast` and `perf` because they need the stack. Tool containers: `--rm`, this uid, `HOME=/tmp`, checkout mounted read-only, evidence directory mounted as `/out`, no published ports, no Docker socket; `--network host` only for ZAP and Artillery, which must reach 127.0.0.1 where `wrangler dev` listens.

**Security gate.** Fingerprints ignore line numbers: `semgrep:<rule>:<file>`, `gitleaks:<rule>:<file>`, `osv:<advisory>:<package>`, `trivy:<id>:<package or file>`. Severities: Semgrep `ERROR` high; gitleaks always critical; OSV `max_severity` CVSS (≥9 critical, ≥7 high, empty unknown); Trivy's own. Only high/critical findings absent from the baseline fail. `--update-baseline` rewrites the accepted set; the committed file is reviewed in its diff.

**GitHub Actions.** `ci.yml` → `_verify.yml` jobs `lint` (setup without cache → `verify --part lint`) and `test` (setup with cache and Bun → `--part build` → `--part test`), 25-minute cap as before. Called jobs surface as `verify / Lint` and `verify / Build and test`.

## Configuration

`FACTORY_INFEROPS_DIR`, `FACTORY_INFEROPS_OFFSET`, `FACTORY_INFEROPS_URL`, `FACTORY_INFEROPS_IMAGE` (image mode), `FACTORY_INFEROPS_DB` (`inferos_factory`), `FACTORY_PG_ADMIN_URL` (the local compose Postgres), `FACTORY_FLOCI_PORT` (4588), `FACTORY_FLOCI_IMAGE` (`floci/floci-gcp:latest`); `FACTORY_RUN_ID`, `FACTORY_BASE_REF` (`origin/main`); `FACTORY_LOCAL_USER`/`FACTORY_LOCAL_PASSWORD` for the browser flow (default the local seed's `dev`/`devpassword`). Images are pulled ahead (`doctor verify` lists them); scanners use `:latest` tags. `.factory/` is gitignored.

## Divergences from Design

- Nodes 0 (intake), 6 (e2e), 9-12 (release, stage smoke, Grok Bot, prod) and rollback are not in the InferOS local graph; the InferOps halves of nodes 4-5 live in that repo.
- `dev` does not start `grokbot` seeding or the coding runner; `verify` does not run a local `registry:2` or build images (InferOS ships Workers).
- Sandboxes are processes on the host, not one rootless container per agent run with egress limits.
- The bindings proof uses `getPlatformProxy` rather than `@cloudflare/vitest-pool-workers`.
- Perf compares against fixed `ensure` ceilings, not the last green run; the DAST scan is unauthenticated and `/api` is not API-scanned.
- `GROKBOT_PERSONA_*` are proposed names.

## Open Questions

- Whether required status checks on `main` need renaming to `verify / Lint` and `verify / Build and test`.
- Who reviews and owns `security-baseline.json`; it was generated from the 2026-10-28 scan and needs a person's acceptance (it includes OSV and Trivy high/critical dependency advisories and one Trivy false positive on a demo principal).
- Whether checkout mode can be bootstrapped without decrypting the InferOps development secrets. Image mode avoids the question but serves the API only: no web clients and no pg-boss worker.
- Without `--inferops-connect`, InferOS in the factory talks to the InferOps gatekeeper's mock (`inferops://demo.local/...`). With it, only stub-mode persona sign-in has been exercised; a Google sign-in against a non-stub InferOps is not.

## Evidence

- Connect (2026-10-29, `FACTORY_INFEROPS_OFFSET=9`, `VITE_BACKEND_HOST=localhost:8797`, reduced environment): `up dev --inferops-image <InferOps feat/factory-demo-integration image> --inferops-connect` was READY; the InferOS login page offered "Continue with InferOps", the InferOps `/authorize` page listed the reserved personas, and as `grokbot-operator` the InferOps connection completed silently, `inferops://grokbot.operations/project/board/GROK` rendered on a canvas, an estimate set with the InferOps CLI showed as "5 pts" after a reload, a move proposed on the card changed InferOps only after approval, and a coding dispatch of a templated project was queued only after approval and claimed by `inferops runner codex --result patch --once`. Evidence under `.factory/runs/demo-<ts>/` of the worktree that ran it (gitignored).

Runs on 2026-10-28 on one shared workstation (Linux 7.0.0-38, 14 CPUs, 62 GiB, Docker 29.9.2; other agents' builds ran concurrently, load average up to 72), cloud/provider variables unset. Evidence directories are under `.factory/` of the worktree that ran them (gitignored):

- Image mode (2026-10-28, `FACTORY_INFEROPS_OFFSET=7`, environment reduced to `PATH`/`HOME`/`USER`/`LANG`/`TERM`): `pnpm local factory up dev --inferops-dir <inferops worktree at 96487788> --inferops-image 127.0.0.1:5600/services/inferlab@sha256:8f8053be…` (the digest the InferOps CI local run built) exited 0: init-db, migrate, seed and the reserved seed ran in that checkout against `inferos_factory`, the container logged `secretLayer: absent`, boot attestation `pass`, `auth: stub`, and `doctor dev` reported READY for credentials, InferOS (19 Workers and the shell) and InferOps (`/health/ready` 200, body `status: ok`, postgres `ok`). The same `doctor` in the unreduced agent shell FAILed `credentials` on `CODEX_COMPANION_SESSION_ID`, `CODEX_COMPANION_TRANSCRIPT_PATH` and `CONTROL_PLANE_API_KEY`. InferOS stayed on the InferOps mock (`pnpm local status`: `inferops.mode: mock`). Against that API (`FACT-1` in the seeded Field Ops workspace, a throwaway clone of an InferOps branch enrolled as the repository), `inferops issue dispatch` as the stub `owner` persona queued a run and `inferops runner codex --result patch --once`, holding a locally minted `dispatcher` (`run:execute`) key, claimed it with the ChatGPT Codex sign-in and finished it `succeeded`: a one-line `README.md` patch, both recorded test commands exit 0. The dispatch did not pass through the InferOS gatekeeper or a Workshop approval. The seeded `ENG` project has no `Queued` State, so dispatching its issues answers `NOT_FOUND`; the demo used a project created with `inferops project create`.
- Sandboxes: `pnpm local factory up dev` brought InferOS up (19 Workers and the shell on :8787) and reported `service:inferops` FAIL honestly: the fresh InferOps worktree exited with "Checkout is not bootstrapped" (`bun run bootstrap` decrypts its development secrets, which this run did not do). `doctor infra` reused `floci-spike` (health JSON with 24 running services); `doctor verify` found all six images; `doctor stage-probe` FAILed naming the four missing smoke variables; `doctor` in the unmodified shell FAILed on three credential-looking names. `down` stopped what `up` started and left `floci-spike` running.
- Pipeline `local-20261029T032938Z-fbc316f` (`--skip verify`): security, build (19 Workers, manifest sha256 recorded), local-deploy (restarted the stack the build had made stale; seed verified the DEMO board), bindings, dast (0 high, 6 medium, 4 low, 3 info) all PASS. Its perf PASS did not count: `ensure` was not enabled then. Perf was re-run as `local-20261029T034025Z-9324290` with the plugin: all nine checks `ok` (HTTP p95 under 500 ms over 960 requests; browser LCP/FCP/CLS/INP/TTFB recorded, step p95s 0.4 s / 0.7 s / 0.9 s). An ad hoc run with a 1 ms p95 ceiling exited 1.
- Seeded secret (`seeded-secret-proof`): an untracked file with a generated AWS-style key made Semgrep, gitleaks (working-tree scan) and Trivy report new high/critical findings and the node exit 1.
- verify: two full runs (`local-20261029T030423Z-fbc316f`, `local-20261029T031758Z-fbc316f`) were red on `pnpm test` from workers OOM-killed (exit 137) and 20 s timeouts under that load, in packages this change does not touch; `pnpm lint` passed in both. With the sandbox down and `VP_RUN_CONCURRENCY_LIMIT=2`, `local-20261029T034455Z-9324290` (`--only verify`) passed `pnpm lint`, `pnpm test` and `pnpm docs:check`. No single run has passed all seven nodes in one go yet.
