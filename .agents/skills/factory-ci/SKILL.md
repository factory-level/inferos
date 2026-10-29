---
name: factory-ci
description: Run and interpret the InferOS side of the software factory's release graph locally - node scripts/ci/pipeline.ts --target=local (pnpm factory:ci) with its verify, security (Semgrep, gitleaks, OSV-Scanner, Trivy against a reviewed baseline), build (wrangler dry-run, no account), local-deploy, bindings, DAST (ZAP baseline) and perf (Artillery HTTP + Playwright engine with Web Vitals) nodes, the evidence under .factory/runs/<id>/, and the reusable _verify.yml + .github/actions layer. Use to prove a change end to end locally, to reproduce a red CI job, or to update a security baseline.
---

# Factory CI (InferOS)

One graph, run the same way in a shell and in GitHub Actions: each node is a script, `scripts/ci/<node>.ts`. `pipeline.ts` runs them as children in order; the composite actions under `.github/actions/*` (called by `.github/workflows/_verify.yml`, which `ci.yml` calls) run the same scripts. Architecture: `docs/architecture/factory.md`.

| Node | Script | Gate |
| --- | --- | --- |
| verify | `verify.ts --part all` | `pnpm lint`, `pnpm test`, `pnpm docs:check` exit 0 (CI uses parts `lint`, `build`, `test`) |
| security | `security.ts` | every scanner ran; no high/critical finding new against `scripts/ci/security-baseline.json` |
| build | `build.ts` | `scripts/release/build-release.ts` (wrangler dry-run bundles + manifest) with no Cloudflare account; manifest sha256 recorded |
| local-deploy | `local-deploy.ts` | all Workers answer through the router, `/` serves the shell, `pnpm local seed` verifies the demo board |
| bindings | `bindings.ts` | every `wrangler.jsonc` binding is in the local run's config and resolves (getPlatformProxy or the running Worker) |
| dast | `dast.ts` | ZAP baseline ran; no high-risk alert new against `scripts/ci/dast-baseline.json` |
| perf | `perf.ts` | Artillery `ensure` passes for `load/inferos-http.yml` and `load/inferos-browser.yml` (Playwright engine, Web Vitals) |

## Run it

```bash
# clean shell: no cloud/provider/prod credentials (the pipeline refuses otherwise)
pnpm local factory up dev            # optional; local-deploy starts the stack itself when it is down
pnpm local factory doctor verify     # tool images present?
pnpm factory:ci                      # = node scripts/ci/pipeline.ts --target=local
node scripts/ci/pipeline.ts --target=local --only security,perf    # a subset
node scripts/ci/perf.ts --part browser --run-id <id>                # one node, into an existing run
pnpm local factory down
```

`--keep-going` runs every node even after a red gate; `--base REF` sets the gitleaks commit range (default `origin/main`). Exit 0 is green; 1 means a gate failed or the run was refused.

## Evidence

`.factory/runs/<run-id>/state.json` lists each node's exit code and duration and the `passes`. Each node writes `.factory/runs/<run-id>/<node>/result.json` (gate, commands, exit codes, details) plus one log per command and its reports: `security/{semgrep,gitleaks-*,osv,trivy,findings,new-findings}.json`, `build/release/manifest.json`, `local-deploy/health.json`, `bindings/result.json`, `dast/zap.{json,html}`, `perf/{http,browser}.json`. Quote these files, not your expectation of them. `.factory/` is gitignored; attach the run id when reporting.

## Guardrails

- Never claim a node passed that you did not run; a node that was skipped or "not run (an earlier gate failed)" is unproven.
- Security baseline: `node scripts/ci/security.ts --update-baseline` rewrites the accepted set from current findings. It is a proposal: show the diff, explain each new entry, and let a person accept it. Never update it to turn a red run green without saying so. A seeded secret or vulnerable dependency must make `security` fail.
- Perf ceilings in `load/*.yml` are proposed (owner-deferred to factory-level/inferos#158; the agreed #28/#158 Kanban budgets cover a different mock measurement). Do not loosen them to pass; report the measured numbers.
- No deploys: `build` is a dry run with Cloudflare variables stripped. Do not add `wrangler deploy` without `--dry-run`, `pnpm stage:deploy`, or preview deploys to this graph.
- Tool containers run as your uid, mount the checkout read-only, publish no ports (`--network host` only for tools that must reach 127.0.0.1) and never get the Docker socket.
- `build` rewrites `packages/workshop-frontend/dist`; a running `wrangler dev` then serves 404 for `/`. `local-deploy` restarts a factory-started stack for that reason; a stack you started by hand must be restarted by you.
- After editing a workflow, run actionlint (`docker run --rm -v "$PWD:/repo:ro" -w /repo rhysd/actionlint:latest`). Called jobs report as `verify / Lint` and `verify / Build and test`.
