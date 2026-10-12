// Which vitest project (see vitest.config.ts) runs each `__tests__/*.test.ts`. Every test file is
// listed in exactly one of these, which `test-projects.test.ts` checks against the directory, so a
// new file fails the suite until it is placed. Each was placed by running it in the cheaper
// environment first: a file sits in `unit-node` only if it passes there with the same results it
// has in workerd.

/**
 * Pure logic, run under Node, where a file costs milliseconds rather than a workerd start.
 * `cloudflare:workers` resolves to `stubs/cloudflare-workers.ts`, which lets a module that declares
 * a Durable Object or entrypoint load but gives none of them runtime behavior. A file that imports
 * `cloudflare:test` cannot be here (`test-projects.test.ts` checks that too).
 */
export const UNIT_NODE: readonly string[] = [
  "admin-config.test.ts",
  "agent-catalog.test.ts",
  "agent-compaction.test.ts",
  "agent-tool-results.test.ts",
  "ai-gateway.test.ts",
  "analytics.test.ts",
  "artifact-store.test.ts",
  "auth-config.test.ts",
  "authz-generation-guard.test.ts",
  "auto-approval.test.ts",
  "blueprint-data-contract.test.ts",
  "blueprint-version-bindings.test.ts",
  "browser-export.test.ts",
  "canvas-catalog.test.ts",
  "chat-attachment-pdf.test.ts",
  "chat-attachment-validation.test.ts",
  "chat-change-statuses.test.ts",
  "chat-model-data.test.ts",
  "chat-taint-guard.test.ts",
  "client-errors.test.ts",
  "cloudflare-account-service.test.ts",
  "code-change.test.ts",
  "code-preview.test.ts",
  "console-host-boards.test.ts",
  "console-tool-surfaces.test.ts",
  "feature-flags.test.ts",
  "gadget-export.test.ts",
  "git-cache.test.ts",
  "git-codec.test.ts",
  "git-migration.test.ts",
  "git-store.test.ts",
  "host-board-account.test.ts",
  "limits.test.ts",
  "message-format-refs.test.ts",
  "mock-storage.test.ts",
  "open-gadget-errors.test.ts",
  "operate-console.test.ts",
  "operate-agui-protocol.test.ts",
  "operate-agui-lifecycle.test.ts",
  "operate-session.test.ts",
  "publication.test.ts",
  "raw-sources.test.ts",
  "site-logo.test.ts",
  "slash-commands.test.ts",
  "streaming-json-parser.test.ts",
  "subject-presence.test.ts",
  "user-verifier.test.ts",
  "web-fetch.test.ts",
  "workspace-kind.test.ts",
  "test-projects.test.ts",
];

/**
 * Needs the workerd runtime (`Uint8Array.prototype.toHex`, `scheduler.wait`, `tracing`, RPC stubs'
 * `dup()`, a Durable Object namespace) but not the backend Worker, so the pool's `main` is the
 * small `workerd/light-worker.ts`. Each file still gets its own module graph (`isolate: true`):
 * several replace modules with `vi.mock`, which a shared graph would leak into the next file.
 */
export const WORKERD_LIGHT: readonly string[] = [
  "access.test.ts",
  "action-log-pagination.test.ts",
  "operate-approval.test.ts",
  "ai-models.test.ts",
  "bundled-blueprints.test.ts",
  "commit-reads.test.ts",
  "do-retry.test.ts",
  "gatekeeper-lookup.test.ts",
  "overseer-hooks.test.ts",
  "sharing.test.ts",
  "user-directory.test.ts",
];

/**
 * Drives the backend Worker (`test-worker.ts`) through `cloudflare:test`. These share one module
 * graph and one Miniflare per pool worker (`isolate: false`), so the backend is evaluated once per
 * worker instead of once per file; a file here must not leave state another file can see.
 */
export const BACKEND: readonly string[] = [
  "operate-agui.test.ts",
  "agent-calls.test.ts",
  "agent-tracing.test.ts",
  "authorize-observation-flags.test.ts",
  "authz-generation.test.ts",
  "chat-changes.test.ts",
  "chat-taint.test.ts",
  "connect-handoff.test.ts",
  "console-agent-tools.test.ts",
  "console-bound-views.test.ts",
  "console-revision-notice.test.ts",
  "console-tool-invocation.test.ts",
  "describe-binding.test.ts",
  "execution-bound-loopbacks.test.ts",
  "gadget-restore.test.ts",
  "git-binding.test.ts",
  "git-migration-do.test.ts",
  "git-push-actions.test.ts",
  "host-boards.test.ts",
  "observer-exclude-scope.test.ts",
  "observer-scope-restart.test.ts",
  "observer-verification-failure.test.ts",
  "pending-login.test.ts",
  "published-consoles-migration.test.ts",
  "restricted-actions.test.ts",
  "spawned-agent-tools.test.ts",
  "tool-lane.test.ts",
  "user-commit-email.test.ts",
  "user-models.test.ts",
  "worktree-session.test.ts",
  "worktrees.test.ts",
];
