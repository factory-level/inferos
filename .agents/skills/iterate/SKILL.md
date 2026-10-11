---
name: iterate
description: The edit-check loop for changing this repository - `pnpm check:fast` after each change, `pnpm check:full` once before hand-off, and CI as the final gate. Use whenever you edit code, tests, scripts or docs here and need to know what to run, and before running any full suite.
---

# Iterate on InferOS

1. After each change, run `pnpm check:fast` from the repository root.
   - **Input:** the branch's changes against its merge-base with `origin/main`, plus staged, unstaged and untracked files.
     - `--base <ref>` picks another base. A base that can't be resolved is an error (exit 2), not "no changes".
     - `--uncommitted` checks only the working tree against HEAD.
     - Paths you pass replace both, e.g. `pnpm check:fast packages/workshop-backend/src/sharing.ts`. A directory means every file in it.
     - Renames count as the old path plus the new one.
   - **For each changed package:**
     - it runs the package's `build` type-check;
     - then, under each vitest config in its `test:run` and after that script's codegen, it runs:
       - the changed test files directly;
       - `vitest related` for the other changed files.
     - When nothing relates to them, or a file was deleted, or a vitest or Vite config changed, that config runs in full.
   - **For `scripts/**`:** it runs every `scripts/` `node --test` suite and `pnpm types:scripts`.
   - **For settings and consumer sources and `env.d.ts`:** it runs `scripts/consumer/settings.test.ts`, which fails when the generated configuration reference is stale.
   - **For `docs/**`:** it runs `pnpm docs:check`.

   It prints one line per step with its time, prints the output of any failure in full, and exits non-zero if anything failed. `--dry-run` shows the plan without running it. It is cheap for test-file changes, so run it often.
2. Read the `NOT CHECKED` list at the end. It names every changed file or package this run did not verify:
   - files outside every package (root configs, the lockfile, skills);
   - deleted test suites;
   - test files no config ran;
   - packages whose tests are not vitest or that have no `test:run`;
   - packages with no `build` task.

   The last line always reminds you that dependent packages and full suites are left to `pnpm check:full`.
3. Run one test file directly with `npx vitest run <file>` in its package (`node --test <file>` under `scripts/`). This works once the package's codegen has run: one `pnpm check:fast`, or the codegen segments of its `test:run`. For example, workshop-backend's backend-loading tests need the generated bundled-blueprints module. `@gadgets/typed-storage` does not need building first.
4. Before hand-off, run `pnpm check:full` once: `pnpm lint`, `pnpm docs:check`, the `scripts/` suites and `pnpm test`, which includes integration. It stops at the first failure and prints a timing summary. CI is the final gate.
5. Never run full suites after every edit, and never edit generated output. `docs/wiki/configuration-reference.md`'s settings table comes from `scripts/consumer/settings.ts`: edit that source, then run `node scripts/consumer/settings.ts` to regenerate the table.

## Costs

- In `workshop-backend`, a test file runs on its own in seconds.
- A `src/` module reached through `__tests__/fixtures.ts` or the backend Worker relates to every test that loads the backend, so expect a minute or more until the suite is split into vitest projects.
- A fixture or other file with no import edge runs its configs in full, which takes minutes.

To see where a backend test file spends its import time, run it with `--experimental.importDurations.print --experimental.importDurations.limit=30`.
