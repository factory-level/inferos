---
title: Runnable synthetic vertical recipes
updated: 2026-10-04
---

# Runnable synthetic vertical recipes

Tracking [#32](https://github.com/factory-level/inferos/issues/32). Three pinned wrapper examples exercise existing native board, approval, skill and customization mechanisms. They are synthetic worklists, not production vertical adapters. The generator does not start a stack, connect an account, upload skills, approve actions or deploy anything.

## Create and run

From a checked-out InferOS source with dependencies installed, choose a reviewed full SHA and a new destination. This baseline is the Wave 4 closeout; it already contains the required wrapper/runtime mechanisms:

```sh
node scripts/recipes/create.ts field-dispatch .worktrees/field-example \
  --repository https://github.com/factory-level/inferos \
  --revision 21708d3449a482843e13cb2268d1ae79451c7dfb --port 28787
cd .worktrees/field-example
pnpm run setup
pnpm inferos:check
pnpm fixtures:check
pnpm views:check
pnpm skills:check
pnpm run doctor
pnpm local start
```

In another terminal in the generated wrapper, run `pnpm local seed`. This creates the synthetic account/workspace and the built-in demo board. **The pinned mock runtime does not import wrapper fixture JSON.** From the generator checkout, explicitly queue the recipe cards and create its saved view:

```sh
node packages/workshop-backend/scripts/propose-recipe.ts .worktrees/field-example
```

Open the printed URL, sign in with the seeded local `dev` / `devpassword` account, and review each creation in the approval queue. The command never approves an action. It uses the recipe catalog's three titles; edited fixture JSON is a validation/reference artifact, not the proposal input. Existing demo cards remain, fixture IDs are not imported, and repeated runs skip titles already present or pending. The operator refuses remote targets and any port other than :28787. Use this only with this wrapper's owned stack. Saved views share the demo project; they are not independently isolated provider datasets. Use `pnpm local verify` and `pnpm local stop` from this wrapper so lifecycle ownership is checked. An occupied port is a refusal, never permission to stop another process. On a shared host that exhausts filesystem watchers, retry this owned stack with `CHOKIDAR_USEPOLLING=1 pnpm local start`; no system-wide watcher settings need changing.

Run one recipe at a time on :28787. The generator refuses protected :8787/:18787. `--repository` also accepts an explicitly supplied absolute local repository path. The full pin is required; no moving branch is selected implicitly. A rerun validates the pin and preserves all wrapper edits, even if a different port is requested. Use explicit wrapper configuration edits for later changes.

## Recipes and truthful limits

| Recipe argument | Synthetic work | Existing mechanism | Unimplemented domain behavior |
| --- | --- | --- | --- |
| `field-dispatch` | Inspection, crew-assignment review and completion cards | InferOps fixture board, approved status changes, existing Operate skills | No actual crew assignment, availability, optimizer, map or mobile offline queue |
| `it-triage` | Sign-in incident, access-request review and export-failure cards | Same guarded board; optional synthetic `gatekeeper-tickets` package | No provisioning, real ITSM provider or separation-of-duties policy |
| `devops-release` | Incident, fixed-commit candidate review and release-decision cards | Same guarded board and action journal | No deployment trigger, commit-bound CI approval, rollback or real coding run |

The inherited wrapper includes editable blueprint sources and standard skill packs. These examples reuse them rather than adding an unreviewed provider. `RECIPE.md` is an operator procedure, not an uploaded agent skill. Tokens, customer data and approval state never enter the generated recipe manifest.

The Tickets connector is already a synthetic conformant package with scope/revision/retry tests. It can be selected explicitly in a wrapper with `pnpm canvas gatekeeper enable gatekeeper-tickets`; it is not a real Jira service or part of default release selection. Run its own conformance suite before claiming its behavior for a recipe.

## Verification session

For each generated fixture, record the pin, recipe, environment and actual board title/cards. Propose a move and reject it; confirm no state/revision change. Propose a fresh move and approve; confirm one change. Make a proposal stale through a competing mutation; approval must refuse rather than overwrite. Duplicate/retry behavior must retain action truth. Remove the binding and verify new reads/proposals cannot use it. A scripted model is acceptable for synthetic mechanism evidence and must be named as such.

Automated setup tests: `node --test scripts/recipes/create.test.ts` creates all three real pinned wrappers, validates the canonical board and views, edits the view/SOP, reruns and proves edits and port survive. It also checks invalid recipes/ports/pins, unrelated destinations and cleanup after failure. Existing `scripts/consumer/maintenance.test.ts` and `reconcile.test.ts` cover upgrade planning, changed-file preservation, merge conflicts and recovery ownership. These tests do not prove a deployed origin or an industry provider.

### Recorded local evidence — 2026-10-04

Runtime pin `21708d3449a482843e13cb2268d1ae79451c7dfb`, local :28787, mock InferOps, direct authenticated Workshop RPC (no model). All three generated wrappers proposed their three catalog cards onto **one isolated shared demo stack**. Separate Chromium views rendered the cards; these were not three independent deployments.

| Check | Result |
| --- | --- |
| Generated wrappers and refusal/preservation tests | 2 tests passed, all three recipes |
| Existing wrapper maintenance/reconcile | 11 passed, 0 skipped (rerun with pnpm on PATH) |
| Tickets / InferOps conformance | 14 / 248 tests passed |
| Recipe create proposals | 3 per recipe, no implicit approval; repeated field proposal returned 0 |
| Rejection / approval / stale revision | Each recipe: rejection preserved revision; fresh approval changed state; old-revision transition refused |
| Browser | All three saved views rendered; no uncaught page errors |

Stale-at-approval, retry/revocation and cross-scope refusal are connector-suite evidence, not additional live recipe claims. Industrial/medical scenario inputs have not executed those domain checks. These results do not satisfy #32's cloud/provider/domain acceptance.

## Reference fixtures

The generator copies `scripts/recipes/fixtures` into `fixtures/recipe-reference`. Both JSON files are marked **scenario-input-only**:

- Industrial monitoring: synthetic asset/site, reordered/stale observations and a foreign asset; future connector checks must refuse cross-site data and control requests. No device transport or safety guarantee.
- Medical administration: synthetic clinic/patient/appointment references and revisions; future checks must refuse wrong-patient/cross-clinic access, stale/double booking and revoked staff. No EHR connector, clinical advice or compliance claim.

Loading JSON is not executing those future checks. The [vertical matrix](vertical-decision-matrix.md) and [priority research](priority-verticals.md) keep provider/customer questions explicit.

## Customization, upgrade and remaining acceptance

Keep views, blueprints, profiles and skills in the wrapper, not its pinned submodule. Run `pnpm inferos upgrade <reviewed-sha> --plan` before an explicit `--apply`; inspect the review report and resolve conflicts without deleting custom files. A source revision change does not imply a domain-data migration or approved production deployment.

#32 remains open for Cloudflare proof (#11), actual provider/customer choices and the unimplemented domain operations above. Industry object/relation packs and schema migrations described in the product notes belong to InferOps; these recipes do not implement them. #65's company-role/restricted-data policy and #158's numeric budgets remain proposed. Harness HG is entirely outside this work.
