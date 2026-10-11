---
name: iterate
description: The edit-check loop for changing this repository - `pnpm check:fast` after each change, `pnpm check:full` once before hand-off, and CI as the final gate. Use whenever you edit code, tests, scripts or docs here and need to know what to run, and before running any full suite.
---

# Iterate on InferOS

1. After each change, run `pnpm check:fast` from the repository root. It reads the branch's changes against its merge-base with `origin/main`, plus staged, unstaged and untracked files, or the paths you pass (`pnpm check:fast packages/workshop-backend/src/sharing.ts`). It runs only what those files can affect:
   - for each changed package, its `build` type-check and `vitest related <files> --run` under each vitest config in its `test:run`, after that script's codegen;
   - for `scripts/**`, the `node --test` suites that import the changed module, and `pnpm types:scripts`;
   - for `scripts/consumer/*`, `scripts/dev-server-config.ts`, `env.d.ts` and settings sources, `scripts/consumer/settings.test.ts`, which fails when the generated configuration reference is stale;
   - for `docs/**`, `pnpm docs:check`.

   It prints one line per step with its time, prints the output of any failure in full, and exits non-zero if anything failed. `--dry-run` shows the plan without running it. It is cheap, so run it often.
2. Read its "not checked here" lines. Root configs, the lockfile and a package's vitest config are covered only by the full run.
3. Run one test file directly with `npx vitest run <file>` in its package (`node --test <file>` under `scripts/`). It works in a fresh worktree; nothing needs building first.
4. Before hand-off, run `pnpm check:full` once: `pnpm lint`, `pnpm docs:check`, the `scripts/` suites and `pnpm test`, which includes integration. It stops at the first failure and prints a timing summary. CI is the final gate.
5. Never run full suites after every edit, and never edit generated output. `docs/wiki/configuration-reference.md`'s settings table comes from `scripts/consumer/settings.ts`: edit that source, then run `node scripts/consumer/settings.ts` to regenerate the table.

`check:fast` checks only the packages that contain the changed files, not the packages that depend on them. In `workshop-backend`, a test file runs on its own in seconds, but a `src/` module reached through `__tests__/fixtures.ts` or the backend Worker relates to every test that loads the backend, so expect a minute or more for those until the suite is split into vitest projects.

To see where a backend test file spends its import time, run it with `--experimental.importDurations.print --experimental.importDurations.limit=30`.
