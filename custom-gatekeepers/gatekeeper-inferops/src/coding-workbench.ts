// The deployment switch for coding dispatch (`CODING_WORKBENCH_ENABLED`, #69) and the wrapper's
// repository allowlist (`CODING_WORKBENCH_REPOS`). Like the integration switch (enablement.ts) it is
// checked on every call of a coding-dispatch binding, not when the binding or session is made, so
// turning it off stops existing bindings, sessions and queued dispatches at their next call and
// turning it on resumes exactly those. Turning it off deletes nothing and turning it on grants
// nothing: a dispatch still needs its own binding, an allowlisted repository, an approval, and the
// person's InferOps `issue:delegate`.
//
// `scripts/consumer/runtime.ts` names this file as the source of the capability.

import { InferOpsError, type InferOpsClient } from "./inferops-client";
import { assertInferOpsEnabled, guarded, inferOpsEnabled } from "./enablement";

/** The message every call refused by the coding switch carries after its `DISABLED: ` code. */
export const CODING_DISABLED_MESSAGE = "Coding dispatch is turned off for this deployment.";

/**
 * Whether the deployment has coding dispatch on. Unlike the integration switch, unset counts as
 * **off**: the capability is new, and enabling it is always the deployer's explicit choice. Only
 * `"true"` is on, and only while InferOps itself is on.
 */
export function codingWorkbenchEnabled(
  env: Pick<Cloudflare.Env, "INFEROPS_ENABLED" | "CODING_WORKBENCH_ENABLED">,
): boolean {
  return env.CODING_WORKBENCH_ENABLED === "true" && inferOpsEnabled(env);
}

/** Throw `DISABLED` while InferOps or coding dispatch is off, naming whichever is. */
export function assertCodingWorkbenchEnabled(
  env: Pick<Cloudflare.Env, "INFEROPS_ENABLED" | "CODING_WORKBENCH_ENABLED">,
): void {
  assertInferOpsEnabled(env);
  if (!codingWorkbenchEnabled(env)) throw new InferOpsError("DISABLED", CODING_DISABLED_MESSAGE);
}

/**
 * A client for a coding-dispatch binding: every call (`forget` aside) is refused with `DISABLED`
 * while either switch is off, checked per call, so an existing binding, session or queued dispatch
 * stops with the switch and resumes with it.
 */
export function whileCodingWorkbenchEnabled(
  env: Pick<Cloudflare.Env, "INFEROPS_ENABLED" | "CODING_WORKBENCH_ENABLED">,
  open: () => InferOpsClient,
): InferOpsClient {
  return guarded(() => assertCodingWorkbenchEnabled(env), open);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The InferOps repository ids the deployment's wrapper allowlists for coding
 * (`CODING_WORKBENCH_REPOS`, comma-separated UUIDs, lowercased). Only ids reach the gatekeeper,
 * never local paths. Unset or empty allows nothing; an entry that is not a UUID is ignored, so a
 * mistyped list fails closed.
 */
export function codingRepoAllowlist(env: Pick<Cloudflare.Env, "CODING_WORKBENCH_REPOS">): Set<string> {
  return new Set((env.CODING_WORKBENCH_REPOS ?? "").split(",")
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => UUID.test(entry)));
}

/** Throw `FORBIDDEN` unless `repoId` is on the deployment's coding allowlist. Makes no request. */
export function assertRepoAllowlisted(
  env: Pick<Cloudflare.Env, "CODING_WORKBENCH_REPOS">, repoId: string,
): void {
  if (!codingRepoAllowlist(env).has(repoId.toLowerCase())) {
    throw new InferOpsError("FORBIDDEN",
      `Repository ${repoId} is not on this deployment's coding allowlist.`);
  }
}
