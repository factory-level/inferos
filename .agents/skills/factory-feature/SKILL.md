---
name: factory-feature
description: The cross-repo software-factory feature pipeline, entered from InferOS (the vessel) - take an InferOps board issue through a model-first plan, dispatch each build stage to the governed coding runner or to Claude, verify each stage from its patch and recorded exit codes, and finish with two PRs (inferops to develop, inferos to main). Holds the InferOS-side stage rules (InferOps DTOs referenced never copied, project-board.schema.json regenerated with --check, gatekeeper/Gadget/canvas per frontend-conventions, covering docs in the same commit). Use only when a person asks to run the factory feature pipeline.
disable-model-invocation: true
---

# Factory feature pipeline (cross-repo entry)

The factory is the skills agents consume plus the sandboxes they run in. InferOS hosts the agents; a feature usually crosses both repositories. This skill is the **entry** and holds the graph. The InferOps half of every stage is `inferops/.claude/skills/factory-feature/SKILL.md` (and the atomic skills it names); read it in the InferOps worktree. The InferOS half is the rules below plus `iterate`, `frontend-conventions`, `write-gatekeeper` and `local-coding`.

Ponytail rule everywhere: the least new code that passes the gate; a deliberate shortcut gets a `ponytail:` comment naming its upgrade path.

## The graph

1. **Intake.** The feature is one InferOps board issue (`inferops://<tenant>.<workspace>/project/board/<KEY>` names the board; scope comes from the capability, never the URI). Pick a run id `<yyyymmdd>-<slug>`; evidence goes under `.factory/runs/<id>/feature/` in **each** worktree (git-ignored).
2. **Plan (stages 0-1, in the conversation).** Ponytail ladder, then `data-model.md` with a mermaid `erDiagram`. A person approves the data model before anything is dispatched. Record the approval (who, when, their words) in `stage-1/approval.json`; an agent's own judgment never counts.
3. **Worktrees.** One per repo: inferops with its `new-worktree` skill (branch off `origin/develop`, a free offset), inferos with `git worktree add -b <branch> .worktrees/<name> origin/main`. Never reuse another run's worktree.
4. **Dispatch per stage.** One stage = one dispatch with fresh context, so each gets its own evidence:
   - **Coding runner** (preferred when ready): an InferOps sub-issue per stage, dispatched through the InferOps gatekeeper's `project/dispatch` binding (simulate, then a person approves `inferops.code-dispatch`); the local runner (`pnpm local runner start`, see `local-coding`) works in a worktree of the allowlisted repo and returns `result.patch` plus `.inferops-artifacts/test-<n>.{json,stdout,stderr}`. It never commits or pushes. Test commands are one line each, argv only (no `&&`, pipes or `$VARS`), so every gate must be one command or a script in the repo.
   - **Claude** (when the runner is not ready): run the stage in the worktree yourself or via the InferOps workflow `.claude/workflows/factory-feature-build.js`, which owns the fix loop.
5. **Verify.** A fresh-context verifier gets only `data-model.md`, the patch or `git diff <base>...HEAD`, and the recorded gate files (`gate.json` or the runner's `test-<n>.json`). Never the implementer's summary. A failure re-dispatches the same stage with the findings, up to the cap (5); the same failing set twice stops the loop.
6. **Order across repos.** InferOps first: stages 2-7 there, committed. Its HEAD SHA is the contract revision. Then InferOS stages, built against that SHA.
7. **Two PRs, opened by a person or on an explicit ask:** inferops branch to `develop`, inferos branch to `main`. The inferos PR names the inferops PR, since its schema pin is that branch's SHA.

## InferOS-side stage rules

| Stage | In InferOS it means | Gate (one command, recorded with `node scripts/factory/gate.ts <run>/stage-<n> --name <gate> -- <cmd>`) |
| --- | --- | --- |
| 1 Data model | InferOps owns the entity. InferOS stores only references, layout and revisions; reference the InferOps DTO, never copy it. | Person's approval |
| 2 Docs | Every architecture doc whose `covers` holds a changed path is updated **in the same commit** as the change; design docs only on stated intent, otherwise a "Divergences from Design" entry. | `pnpm docs:check` |
| 3 Migrations | No database here. A board DTO change means regenerating `scripts/consumer/project-board.schema.json` from a clean tracked InferOps checkout at the reviewed SHA, then checking it; update the pins that name that revision (`custom-gatekeepers/gatekeeper-inferops/connection.json`, `scripts/consumer/fixtures.test.ts`) and the fixtures only if the schema requires it. Durable-view or config schema changes go in `scripts/consumer/`. | `node scripts/consumer/generate-board-schema.ts <inferops-worktree> <40-char sha>` then the same with `--check` |
| 4 API | The gatekeeper's typed session (`types.d.ts`, read `write-gatekeeper` first): parse only what the card needs (`http-inferops.ts`), refuse malformed data, writes through simulate/approve with an expected revision. Contract tests first, recorded red, then green. | `pnpm --filter <gatekeeper> exec vitest run <test file>` |
| 5 Entrypoints | Gadgets and canvas widgets (read `frontend-conventions`: Kumo components and tokens, no colour literals, PascalCase component files, tests of observable behavior). | `pnpm --filter <pkg> exec vitest run <test file>` |
| 6 Standards | Server logging only through `@gadgets/observability/logger`, no secrets or bodies in logs; a browser card adds no telemetry. | `pnpm lint` |
| 7 Loop | `iterate`: `pnpm check:fast` per change, then the full gates. | `pnpm lint`, `pnpm test`, `pnpm docs:check` |

Hard stops:

- **Kernel.** If a change would touch `packages/workshop-backend/` or `packages/workshop-shared/src/api.ts`, stop and split it: kernel and UI go in separate PRs, held to the kernel bar in `REVIEW.md`.
- **Authority.** Feature flags, profiles, URIs and widget params never grant access; the gatekeeper capability does.
- **Toolchains.** pnpm/node here, bun only where a script requires it (the schema generator runs Bun inside the InferOps checkout). Never run InferOps commands from this tree or the reverse.
- **No proof by config.** A validated config or a mocked runner is never reported as a live pass.

## Evals

`evals/evals.json` holds the scenarios this skill must handle.
