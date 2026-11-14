---
title: Archive main and start a clean upstream baseline
updated: 2026-11-14
---

# Archive main and start a clean upstream baseline

This runbook keeps a checksummed recovery point for this fork's `main` and starts a new InferOS line
from real upstream Cloudflare OS, not from a partly stripped fork. **Ref protection is pending:** on
2026-11-14 the step 3b rulesets were not yet applied, so the archive refs have only ordinary write
access, and both bundle copies are on the same host disk. Step 3b says what would protect them and
what doesn't. It belongs to FAC-213 (BOS-02) in
the Linear project "InferLab — Local Business OS Demo". FAC-214 then ports only InferLab sign-in onto
the clean branch, and FAC-215 proves gate G0 on it with the checks AUTH-01 to AUTH-17.

The procedure is additive. It creates refs, a bundle and a new branch. It never force-pushes. It never
deletes or rewrites `main` or any existing branch or tag. It never changes the default branch. It
never deploys anything. The execution record of the first run, on 2026-11-14, is at the end.

## Rules

- **Archive before anything new.** The archive branch, the annotated tag and the bundle exist and are verified before the clean branch is created or anything else is pushed.
- **Never move main.** `main`, every existing branch and every tag stay as they are. There is no force push, `--force-with-lease` or `git push --delete`.
- **Never change the default branch.** That is the owner's decision. Write it as a proposal on the ticket instead. The manager decided on 2026-11-14 that it stays `main`.
- **Protect what you archive.** The archive refs go under rulesets that refuse deletion and any update (step 3b), and the bundle files are made read-only with a second copy. A ref or file is only as immutable as the control actually enforced on it, so the record says which controls are in place. On 2026-11-14 the rulesets are pending and the second copy shares the host's disk.
- **No deploy and no shared namespace.** No `pnpm stage:deploy`, `wrangler deploy` or preview deploy. The native baseline runs locally on Miniflare only. A stage's `workerPrefix` (`inferos-dev-`, `inferos-prod-`) is never reused, because Durable Objects belong to the worker name.
- **Keep old state separate.** The old fork's local runtime state (`.wrangler/state`, `~/.config/inferos/worktrees.json`, the deploy checkouts' `.stage-*.vars`) is never copied into the clean worktree. Archive any state you have to remove, outside every worktree.
- **Mock mode for the baseline.** The clean worktree gets no `.env` or `.dev.vars` with provider keys, and commands run from a clean shell, so no live model is reached.

## Before you start

- Work from a clean shell: `env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 bash`. pnpm comes from corepack.
- Run every install, build, test and stack through the host's `heavy-run`. A full test graph and a running stack also take its stack lock.
- **Port blocks.** `pnpm wt new` allocates one block of ten from 8800–9199. It skips every block that overlaps InferOps' port residues (`clashesWithInferOps` in `scripts/wt/layout.ts`: x00–x02, x80, x87, x90), which leaves 28 usable blocks. Check what holds them with `pnpm wt ls` and `~/.config/inferos/worktrees.json`. A block is free only when its registry entry goes; `pnpm wt rm` refuses a worktree with ignored local state unless given `--force`. Remove only worktrees that are provably finished: clean, with no process running from their path, and a HEAD already in `origin/main`. Remove nobody's worktree without the team's decision.
- **The backup directory.** Pick one outside the scratchpad and outside every worktree, for example `~/backups/inferos-<ticket>/`.

## Steps

### 1. Capture main

```bash
git fetch origin
git ls-remote origin refs/heads/main      # must equal the next line
git rev-parse origin/main                 # the captured SHA, S
git ls-remote origin 'refs/heads/*' 'refs/tags/*' > <backup>/inferos-remote-refs-<date>.txt
git ls-remote origin 'refs/heads/archive/*' 'refs/tags/main-archive-*'   # must be empty, or pick new names
```

The ref list records every other branch's tip at the moment of capture. Nothing else is bundled,
because this procedure moves none of those branches.

### 2. Make and verify the archive locally

```bash
git branch archive/main-<date> <S>
git tag -a main-archive-<date> <S> -m "FAC-213: inferOS main before the clean upstream reset, captured <time> (<S>)"
git bundle create <backup>/inferos-main-<S12>-<date>.bundle \
  refs/heads/archive/main-<date> refs/tags/main-archive-<date>
git bundle verify <backup>/inferos-main-<S12>-<date>.bundle      # "The bundle records a complete history."
git bundle list-heads <backup>/inferos-main-<S12>-<date>.bundle
sha256sum <backup>/inferos-main-<S12>-<date>.bundle | tee <backup>/inferos-main-<S12>-<date>.bundle.sha256
```

Then restore-test it. A bare clone from the bundle must resolve both refs to `S` and pass `git fsck`:

```bash
git clone --bare <bundle> <scratch>/bundle-check
git -C <scratch>/bundle-check rev-parse archive/main-<date> 'main-archive-<date>^{commit}'
git -C <scratch>/bundle-check fsck
```

### 3. Push the archive and prove it

```bash
git push origin refs/heads/archive/main-<date>:refs/heads/archive/main-<date> \
                refs/tags/main-archive-<date>:refs/tags/main-archive-<date>
git ls-remote origin refs/heads/main refs/heads/archive/main-<date> \
                     refs/tags/main-archive-<date> 'refs/tags/main-archive-<date>^{}'
```

`archive/main-<date>`, the peeled tag and `main` must all print `S`. Step 1's emptiness check is what
keeps this push from moving anything. A tag push fails when the tag exists, but a non-force push of an
existing **branch** succeeds when it is a fast-forward, so it would move a branch already sitting at an
ancestor. Re-run the step 1 check right before this push if any time has passed.

### 3b. Protect the archive

**Refs.** Two repository rulesets, with enforcement active and no bypass actors. A ruleset has a single
target type, so branches and tags each need their own:

```bash
gh api -X POST repos/factory-level/inferos/rulesets --input - <<'JSON'
{"name":"archive-immutable-branches","target":"branch","enforcement":"active","bypass_actors":[],
 "conditions":{"ref_name":{"include":["refs/heads/archive/**"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},{"type":"update"}]}
JSON
gh api -X POST repos/factory-level/inferos/rulesets --input - <<'JSON'
{"name":"archive-immutable-tags","target":"tag","enforcement":"active","bypass_actors":[],
 "conditions":{"ref_name":{"include":["refs/tags/main-archive-*"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},{"type":"update"}]}
JSON
```

Prove both rulesets against throwaway probe refs under the same patterns. The rules don't include
`creation`, so the probes can be created after the rulesets. **Never test against the real archive
refs.**

```bash
git push origin <S>:refs/heads/archive/ruleset-probe-<date>
git push origin <S>:refs/tags/main-archive-ruleset-probe-<date>   # a lightweight tag is enough
# then, with both rulesets active:
git push origin --delete archive/ruleset-probe-<date>                       # must be refused
git push origin <child of S>:refs/heads/archive/ruleset-probe-<date>        # a fast-forward: must be refused
git push origin --delete refs/tags/main-archive-ruleset-probe-<date>        # must be refused
```

The probes stay as evidence. Afterwards, `gh api repos/factory-level/inferos/rulesets` lists both
rulesets with `bypass_actors: []`. A repository admin can still edit or delete a ruleset, so the
rulesets stop accidents and every writer without admin, not an admin acting on purpose. Each
ruleset change shows in the repository's rule history.

**Bundle.** `chmod 0444` the bundle, its `.sha256` and the ref list, `chmod 0555` the directory, and
keep a second copy on another path. A local file can still be changed by this user (who can `chmod`
it back) or by root, so read-only modes stop accidents, not tampering. **The integrity check is the
sha256:** it is recorded in the pull request and in the ticket's closure, so compare any copy against
that recorded value, never against a `.sha256` file stored beside it.

### 4. Inspect deployment triggers

Read every `.github/workflows/*.yml` in **both** trees: this fork's `main` and upstream's head. The
clean branch carries upstream's workflow files, not this fork's. Confirm all three of these:

- No workflow fires on a push to a branch named `archive/*` or `clean/*`, or on a tag push. Today only `ci.yml` and `workshop-evals-pr.yml` have a `push` trigger, and both are limited to `main`.
- Every deploy job is guarded so it can't run here. `preview.yml`'s deploy, delete and sweep jobs require `github.repository_owner == 'cloudflare'`, in both trees; their check runs on this repository's `main` show `skipped`.
- Scheduled workflows run only from the default branch, so upstream's `github-contract.yml` schedule stays inert while `main` is the default.

Also check that nothing outside Actions deploys on push. `gh api repos/<repo>/hooks` should list no webhooks, the commit's check runs should list only `github-actions`, and `gh api repos/<repo>/environments` should list no environments. The persistent stages deploy only from a workstation with `pnpm stage:deploy` ([Deploy a persistent stage](stage-deploy.md)).

**Pull requests on the clean line.** A `pull_request` run uses the workflow files from the pull
request's merge commit. A pull request **from** the clean branch, or one whose **base** is a
`clean/*` branch (FAC-214's path), therefore runs upstream's workflows with whatever secrets reach
this repository. What makes that safe today, checked on 2026-11-14:

- **Disabled workflows.** `Bonk`, `Bonk PR Review` and `CLA Assistant` are `disabled_manually` in this repository (`gh workflow list --all`). The disabled state is per workflow file, so it holds on every branch.
- **Secrets.** The repository has 0 Actions secrets of its own (`gh api repos/factory-level/inferos/actions/secrets`). Three organization secrets reach it (`gh api …/actions/organization-secrets`): `ACTIONS_PAT`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
- **The only exposure.** Of those three, upstream's workflows reference only `CLOUDFLARE_API_TOKEN`, and only in `preview.yml`'s deploy, delete and sweep jobs, which require `github.repository_owner == 'cloudflare'`. The AI Gateway secrets that Bonk and the eval workflows read do not exist here, and the eval jobs depend on an owner-guarded `plan` job.

So today the Cloudflare token is kept out of an upstream-workflow run by one `if:` guard. Re-enabling
a disabled workflow, or adding a secret, changes this. **The manager's decision (2026-11-14):** FAC-214
starts with a pull request on the clean branch that neutralizes upstream's secret-bearing and deploy
workflows for this repository. That is the first pull request whose base is `clean/*`; nothing else
opens one first. Review of the clean branch itself happens without a pull request.

### 5. Pin upstream and create the clean branch

```bash
git fetch upstream
git ls-remote https://github.com/cloudflare/cloudflare-os.git refs/heads/main   # the pin, U
pnpm wt new <name> --from <U> --branch clean/upstream-<date>
git -C .worktrees/<name> diff <U> HEAD | wc -l      # must be 0
rm .worktrees/<name>/.env                            # pnpm wt links the main checkout's .env; it may hold provider keys
```

The branch tip is upstream's commit itself, with no commit of ours on it. Remove only the symlink: the
main checkout's `.env` stays.

### 6. Run the native baseline

This step uses upstream's own scripts, in the clean worktree, in mock mode:

```bash
pnpm build                                  # upstream: vp run --cache build over every package
pnpm test                                   # upstream: vp run --cache test (unit and integration)
pnpm run-local --port <block base>          # never 8787: that is the InferOps offset-0 sidecar port
```

Then run a native Gadget smoke against the running instance with upstream's own API client,
`packages/api-cli`:

```bash
export CFOS_API_PASSWORD=<a throwaway local password>
pnpm cf-os api --url http://localhost:<port> create-account <user>
pnpm cf-os api --url http://localhost:<port> --username <user> whoami
pnpm cf-os api --url http://localhost:<port> --username <user> new-workspace set-title "Baseline smoke"
```

Then make a Gadget, list it back, and instantiate a featured (bundled) Blueprint:

```bash
api="pnpm cf-os api --url http://localhost:<port> --username <user>"
$api open-workspace <workspaceId> create-gadget "Smoke gadget" get-export-formats   # a chain must end on a value
$api --timeout 5 open-workspace <workspaceId> subscribe-to-workpieces   # lists the gadget
$api list-featured-blueprints
$api new-workspace-from-blueprint <blueprintId> '{}' get-metadata       # e.g. format.document → "Workspace Docs"
$api list-workspaces                                                    # only the blueprint-created workspace
```

`list-workspaces` hides provisional workspaces. The one `new-workspace` made, with a gadget but no
other activity, is provisional, so it is omitted. Only the workspace created from the Blueprint
("Workspace Docs") comes back. An account with no non-provisional workspace gets `[]`.

Stop the server once the smoke is recorded. Its state stays in the clean worktree's own
`.wrangler/state`.

### 7. Push the clean branch

```bash
git ls-remote origin refs/heads/clean/upstream-<date>       # must print nothing, checked right before the push
git push origin clean/upstream-<date>:refs/heads/clean/upstream-<date>
git ls-remote origin refs/heads/clean/upstream-<date>       # must print U
```

The emptiness check is what makes this push create a branch rather than move one: a fast-forward push
to an existing branch would succeed. Check `gh run list` afterwards: no run should have started.

## Rollback

Nothing in this procedure moves an existing ref, so rollback only removes what it added. A person does
this; this runbook never does.

- **Undo the clean branch.** Delete `clean/upstream-<date>` on the remote, then remove the local worktree with `pnpm wt rm <name>`.
- **Undo the archive.** Not needed. The archive refs are harmless. Delete them only after the bundle has been checked against them.
- **Recover old main if it were ever moved.** Fetch `archive/main-<date>` or the tag, or clone from the bundle (`git clone <bundle>` and check out `archive/main-<date>`). Compare its SHA with the `.sha256` record and with the captured `S`.
- **Recover removed worktree state.** Each archived `.wrangler/state` is a tarball in the backup directory. Extract it into a worktree's root with `tar -xzf`.

## Execution record, 2026-11-14

Run by the dev-build seat for FAC-213, from `.worktrees/fac-213-reset-runbook` (this runbook's branch)
and `.worktrees/fac-213-clean-baseline`. All commands ran in a clean shell through `heavy-run`.

**Port blocks.** All 28 usable blocks were registered, so `pnpm wt new` failed. Six registered
worktrees were provably finished. The lead approved removing two of them: `proof-m` (8860) and
`proof-n` (8870), both clean at `a6c0ca64`, which is in `origin/main`, with no process running and a
last commit of 2026-10-11. Their branches `proof/proof-m` and `proof/proof-n` are kept. Their ignored
`.wrangler/state` was archived first:

- `~/backups/inferos-fac-213/proof-m-wrangler-state-2026-11-14.tar.gz`
- `~/backups/inferos-fac-213/proof-n-wrangler-state-2026-11-14.tar.gz`

Then each was removed with `pnpm wt rm <name> --force`.

| Step | Result |
| --- | --- |
| 1. Captured main, 13:25Z | `S = 24f5d8852a2291b846f1c12ae6fd5eb6e172e108`; `ls-remote` and `origin/main` agree. 366 remote refs recorded in `~/backups/inferos-fac-213/inferos-remote-refs-2026-11-14.txt`. No `archive/*` or `main-archive-*` refs existed. |
| 2. Archive made locally | Branch `archive/main-2026-11-14` → `24f5d885`. Annotated tag `main-archive-2026-11-14` (tag object `06e59960b8a6b8027070b7fe7e39bcd9e295c5cb`) → `24f5d885`. |
| 2. Bundle | `~/backups/inferos-fac-213/inferos-main-24f5d8852a22-2026-11-14.bundle`, 18,697,922 bytes. sha256 `b938b601176e85260797f761a00348c43325798f0a923bcdcaca0178ca7b4fd1`, stored beside it in the `.sha256` file. `git bundle verify`: "The bundle records a complete history"; heads are the branch and the tag. Restore test: a bare clone resolves both to `24f5d885`, `git fsck` exits 0, and history holds 1338 commits. |
| 3. Archive pushed | Two new refs and no force. `ls-remote` shows `refs/heads/archive/main-2026-11-14` = `refs/heads/main` = `refs/tags/main-archive-2026-11-14^{}` = `24f5d885`. `gh run list` shows no run started by the push. |
| 3b. Ref rulesets | **Not applied yet.** The account has admin on the repository (`permissions.admin: true`), but the build seat's request to create the two rulesets above was refused by its session's permission policy. A person applies them, with the commands in step 3b, and records the ruleset ids and the probe refusals here. Until then the archive refs are protected by nothing beyond ordinary write access: the one active ruleset, 26395522, targets only the default branch. |
| 3b. Bundle (14:00Z) | `chmod 0444` on the bundle, its `.sha256`, the ref list and the two state tarballs, and `chmod 0555` on `~/backups/inferos-fac-213/`. Second copy on another path: `~/Documents/inferos-archive-2026-11-14/` (bundle, `.sha256`, ref list), with the same modes. Hashing the copy directly gives `b938b601…7b4fd1`, and `cmp` finds it identical. Both copies are on the host's only disk, so this guards against an accidental change or deletion of one path, not against losing the disk. No off-host copy was made, because that would send the archive outside the team. The recorded sha256 is the integrity check. |
| 4. Triggers | As described in step 4, checked at `24f5d885` and at upstream `9e8acadb`: push triggers are `main`-only, the preview jobs are owner-guarded (`skipped` on `main`'s check runs), there are no webhooks, the only check-run app is `github-actions`, and there are no environments. No workflow was edited. |
| 5. Upstream pin | `U = 9e8acadb79dd3aa9671199f3f10aea307d7e5300` (cloudflare/cloudflare-os `main`, committed 2026-11-13T18:53:15-06:00, #1122). |
| 5. Clean branch | `clean/upstream-2026-11-14`, tip `9e8acadb`. `git diff 9e8acadb HEAD` is 0 lines. Worktree `.worktrees/fac-213-clean-baseline` on ports 8870–8879. The linked `.env` was removed, there is no `.dev.vars`, and `.env.worktree` holds only port and concurrency names. |
| 6. `pnpm build` | 94 of 94 tasks successful; 1 of 68 cached. |
| 6. `pnpm test`, first run | **Failed.** vp reported 40 of 43 tasks successful. `@gadgets/api-cli#test` failed 1 of 205: `src/session.test.ts`, "a real listener that answers TLS with garbage…". It expects the OpenSSL message "wrong version number", but this host prints "packet length too long". vp then stopped `workshop-frontend#test` and `configurator-ui#test` (exit 137), and the larger suites never started. The failure reproduces outside vp with `node --test`. The host runs Node 24.14.0 (OpenSSL 3.5.5), while upstream CI pins 24.19.0. That the Node version is the cause is a hypothesis, not checked here. The fork has no `api-cli`: it arrived upstream on 2026-11-04 (#860). |
| 6. `pnpm test`, the rest | Re-run as `node scripts/vp/run.ts --filter=!cloudflare-os --filter=!@gadgets/api-cli --cache test`: 78 of 80 tasks. Every test task was a real run (cache miss) apart from 9 that replayed this worktree's own first-run passes. `integration-tests`, `workshop-frontend`, `mcp-shared` and every gatekeeper's tests passed. Two failed, both from the run environment, not the code: (a) `workshop-evals#test`. Headless Chromium crashed at launch because vp's file-system spy (`fspy_preload_unix`, which `vp run` injects for caching) panicked with `ESRCH`. Run directly (`vitest run --config vitest.config.ts --maxWorkers=2`), it passes 143 of 143. (b) `workshop-backend#test`, stopped (137) after (a). Run directly (`pnpm run test:run`), it gives 2644 of 2645. The one failure is a fast-check property in `__tests__/unread-state.test.ts` interrupted by its 90 s time limit after 57 cases, under host load, with no counterexample. Run alone, that file passes 59 of 59. Then `vitest.integration.config.ts` gives 3 passed and 4 skipped, and `vitest.native.config.ts` gives 5 of 5. |
| 6. `pnpm run-local --port 8870` | Ready in about 50 s. `GET /` returned 200, `<title>Cloudflare OS</title>`. Mock mode: no `.env` or `.dev.vars`, a clean shell, and no Workers AI binding flag. |
| 6. Native Gadget smoke (`pnpm cf-os api --url http://localhost:8870`) | `create-account` and `whoami` both succeed. `new-workspace set-title "Baseline smoke"` creates a workspace. `open-workspace <id> create-gadget "Smoke gadget" get-export-formats` exits 0, and `subscribe-to-workpieces` then lists `{"type":"gadget","title":"Smoke gadget","commitId":"135be5b6…"}`. `list-featured-blueprints` listed 9 entries (run as account `smoke2`). In a separate run as account `smoke4`, `new-workspace-from-blueprint format.document '{}' get-metadata` created "Workspace Docs" with `defaultGadgetId: 0` and role `build`. `list-workspaces` printed `[]` in the run as account `smoke3`. In that run `new-workspace-from-blueprint` was not yet chained to a value, so it sent nothing (exit 0, "nothing was sent") and the account's only workspace was the provisional one, which `list-workspaces` hides. The later run that did create "Workspace Docs" (account `smoke4`) did not call `list-workspaces`. QA's re-run at `1f38cf9c` returned exactly "Workspace Docs" ([comment](https://github.com/factory-level/inferos/pull/504#issuecomment-6878558231)). The accounts and password were throwaway and local. The server was stopped afterwards; nothing was left listening on 8870–8879 and the stack lock was released. |
| 7. Clean branch pushed, 13:50Z | `ls-remote origin refs/heads/clean/upstream-2026-11-14` printed nothing immediately before the push. A new branch, no force. `ls-remote` shows `refs/heads/clean/upstream-2026-11-14` = `9e8acadb`, while `main` and `archive/main-2026-11-14` stay at `24f5d885`. `gh run list` shows no run started by the push. |

**Decisions recorded (the manager, 2026-11-14):**

- **Default branch.** It stays `main`.
- **api-cli test.** Its Node difference is recorded, not patched. The clean branch is not edited to make the `api-cli` TLS-message test pass on this host.
- **FAC-214's first step.** It opens a pull request on the clean branch that neutralizes upstream's secret-bearing and deploy workflows, before any other pull request with a `clean/*` base (step 4).

**What the clean baseline needs next:**

- A person applies the step 3b rulesets and records their ids and the probe refusals here.
- When a heavy browser suite fails at Chromium launch, run it outside `vp run`, or with `vp`'s file spy off. Note it as an environment failure, not a code failure.

**Not done:**

- no deploy of any kind;
- no change to the default branch or to any workflow;
- no pull request from, or onto, the clean branch;
- the archive rulesets (see 3b);
- no live model or provider, so this is mock mode only;
- no browser walkthrough, since the smoke used upstream's API client.
