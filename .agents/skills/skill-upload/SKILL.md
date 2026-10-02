---
name: skill-upload
description: Add, author or publish runtime skills for an InferOS wrapper's Workshop agent. Use when asked to upload a skill, install a skill from skills.sh, create a new skill for the operate, build or shared pack, or sync the wrapper's skills into the local InferOS Context Library.
---

# Skill upload

A generated InferOS wrapper (identified by `inferos.config.json` and `inferos.skills.json`) keeps skills in two places:

| Where | Who uses it | Managed by |
| --- | --- | --- |
| `.agents/skills/<name>/` | coding agents working on this repo | `pnpm skills:install` (pinned skills.sh CLI) → `skills-lock.json` |
| `skills/<pack>/<name>/` | the Workshop agent, as `/` commands in chat | wrapper files plus `pnpm skills:upload` |

`inferos.skills.json` maps each pack (`operate`, `build`, `shared` to start) to one public Context Library collection, found again by title. A pack's `include` list publishes an installed `.agents/skills/<name>` directory as part of the pack, so a skill is never copied twice. `build` includes `skill-creator`. `exclude` drops eval and workspace output.

## Choose the pack

- **operate**: running InferOps work (boards, issues, approvals, reporting).
- **build**: making gadgets, views, blueprints and skills.
- **shared**: rules every agent task should follow.

If the request does not make the pack obvious, ask. Add a new pack only on request: it means a new public collection.

## Steps

1. **Validate first.** Run `pnpm skills:check`. A warning that an include is not installed means run `pnpm skills:install` (no arguments installs skill-creator). Fix errors before going on: an invalid `SKILL.md` would be silently left out of the Workshop.
2. **Get the skill.**
   - From skills.sh or GitHub: `pnpm skills:install <owner/repo> --skill <name>`. That makes it available to coding agents. To make the Workshop agent see it too, add `.agents/skills/<name>` to the chosen pack's `include`.
   - New skill: if skill-creator is installed, follow it to draft, test and refine the skill, then save the result as `skills/<pack>/<name>/SKILL.md`, with any `references/`, `scripts/` or `assets/`. Otherwise write that file directly. Frontmatter needs `name` (lowercase letters, numbers and single hyphens, at most 64 characters, matching the folder) and `description` (at most 1024 characters, saying what it does and when to use it). Skill names must be unique across all packs.
   - Write runtime skills for the sandboxed Workshop agent. It acts through granted gatekeeper bindings and cannot run the wrapper's shell or Python scripts. Use `$ARGUMENT` where the slash-command text should go.
3. **Re-run `pnpm skills:check`.**
4. **Preview.** With `pnpm dev` running and the operator having provided `INFEROS_ADMIN_SESSION` privately, run `pnpm skills:upload <pack> --dry-run`, then show the user the `created` / `updated` / `stale` lists. Do not read, print or guess the session token.
5. **Publish.** Run `pnpm skills:upload <pack>`. Add `--prune` only when the user agrees that the `stale` files, which may be edits made in the Context Library UI, should be deleted.
6. **Report.** Give the collection, the skills published and anything skipped. The user can confirm by typing `/` in Workshop chat. Uploads target the local Workshop only, since deployed instances have no upload path yet.

Never claim a skill works against real InferOps data: board data is still mocked, and an uploaded skill describes behavior, it does not grant access. Commit wrapper skill changes like any other source file.
