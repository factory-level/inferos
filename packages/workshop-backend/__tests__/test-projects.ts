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
  "rpc-target-validation.test.ts",
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
  "authored-widget-build.test.ts",
  "authored-widget-build-runtime.test.ts",
  "authored-widget-preview.test.ts",
  "browser-export.test.ts",
  "canvas-catalog.test.ts",
  "action-receipt-scope.test.ts",
  "canvas-store-page-edits.test.ts",
  "canvas-writes.test.ts",
  "canvas-store-pages.test.ts",
  "canvas-store-newer-widgets.test.ts",
  "console-publication-authority.test.ts",
  "console-publication-pages.test.ts",
  "console-publication-apps.test.ts",
  "console-widget-index.test.ts",
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
  "console-draft-problems.test.ts",
  "console-embedded-widget.test.ts",
  "workspace-configuration.test.ts",
  "console-widget-events.test.ts",
  "page-prompts-storage.test.ts",
  "feature-flags.test.ts",
  "gadget-export.test.ts",
  "git-cache.test.ts",
  "git-codec.test.ts",
  "git-migration.test.ts",
  "git-store.test.ts",
  "host-board-account.test.ts",
  "limits.test.ts",
  "message-format-refs.test.ts",
  "model-bounds.test.ts",
  "mock-storage.test.ts",
  "open-gadget-errors.test.ts",
  "operate-console.test.ts",
  "operate-agui-protocol.test.ts",
  "operate-agui-lifecycle.test.ts",
  "operate-session.test.ts",
  "operate-flow-navigation.test.ts",
  "handover-delivery.test.ts",
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
  "authored-widget-publication.test.ts",
  "access.test.ts",
  "action-log-pagination.test.ts",
  "operate-approval.test.ts",
  "operate-approval-actions.test.ts",
  "ai-models.test.ts",
  "bundled-blueprints.test.ts",
  "commit-reads.test.ts",
  "do-retry.test.ts",
  "gatekeeper-lookup.test.ts",
  "action-context-reconnect.test.ts",
  "overseer-hooks.test.ts",
  "sharing.test.ts",
  "shared-configuration.test.ts",
  "action-decisions.test.ts",
  "workflow-definitions.test.ts",
  "workflow-dynamic-definitions.test.ts",
  "workflow-invocation.test.ts",
  "workflow-definition-shares.test.ts",
  "workflow-definition-duplicates.test.ts",
  "workflow-system-run.test.ts",
  "user-directory.test.ts",
];

/**
 * Drives the backend Worker (`test-worker.ts`) through `cloudflare:test`. These share one module
 * graph and one Miniflare per pool worker (`isolate: false`), so the backend is evaluated once per
 * worker instead of once per file; a file here must not leave state another file can see.
 */
export const BACKEND: readonly string[] = [
  "workspace-readiness.test.ts",
  "agent-spawner-config.test.ts",
  "approved-workflow-run.test.ts",
  "operate-flow-start.test.ts",
  "widget-state.test.ts",
  "widget-event-navigation.test.ts",
  "personal-state-partition.test.ts",
  "widget-placements.test.ts",
  "workflow-requested-runs.test.ts",
  "run-navigation.test.ts",
  "workflow-run-delivery.test.ts",
  "workflow-definition-expiry-alarm.test.ts",
  "temporary-canvases.test.ts",
  "approved-temporary-canvas.test.ts",
  "agent-tracing.test.ts",
  "authored-widget-publish-flow.test.ts",
  "authorize-observation-flags.test.ts",
  "chat-changes.test.ts",
  "chat-taint.test.ts",
  "connect-handoff.test.ts",
  "agent-widgets.test.ts",
  "console-agent-tools.test.ts",
  "console-bound-views.test.ts",
  "console-revision-notice.test.ts",
  "console-tool-invocation.test.ts",
  "console-commands.test.ts",
  "describe-binding.test.ts",
  "execution-bound-loopbacks.test.ts",
  "gadget-restore.test.ts",
  "git-binding.test.ts",
  "git-push-actions.test.ts",
  "observer-exclude-scope.test.ts",
  "observer-scope-restart.test.ts",
  "observer-verification-failure.test.ts",
  "pending-login.test.ts",
  "restricted-actions.test.ts",
  "spawned-agent-tools.test.ts",
  "user-commit-email.test.ts",
  "user-models.test.ts",
  "workflow-assigned-writes.test.ts",
  "action-failure-kinds.test.ts",
  "worktree-session.test.ts",
];

/**
 * Backend files that restart every Durable Object (`abortAllDurableObjects()`). In the shared
 * `backend` runtime that would also restart, mid-test, the objects of other files the same worker
 * ran, which breaks them (and can crash workerd: see `workerd/backend-file-boundary.ts`). So these
 * run in their own project, `backend-restart`, after `backend`, one file at a time, each with its own
 * Miniflare. Every file that calls it belongs here; `test-projects.test.ts` checks that.
 */
export const BACKEND_RESTART: readonly string[] = [
  "agent-calls.test.ts",
  "authz-generation.test.ts",
  "git-migration-do.test.ts",
  "host-boards.test.ts",
  "operate-agui.test.ts",
  "published-consoles-migration.test.ts",
  "tool-lane.test.ts",
  "workflow-run-execution.test.ts",
  "workflow-run-restart.test.ts",
  "workflow-run-results.test.ts",
  "worktrees.test.ts",
];

/**
 * Backend files that drive a real gatekeeper sign-in through the login callback, which reads the
 * admin config from `BLUEPRINTS`. They run in their own project, `backend-sign-in`, whose Miniflare
 * alone has that namespace (empty, so signups are open), so no other file's runtime changes.
 */
export const BACKEND_SIGN_IN: readonly string[] = [
  "account-subject.test.ts",
];
