// The deployment switch for the InferOps integration (`INFEROPS_ENABLED`, capability flag #33).
// coding-workbench.ts applies the same per-call guard to coding dispatch.
//
// It is checked on every data-source call, not when a binding or session is made, so a binding or
// session that exists when the integration is turned off is refused from its next call on, and works
// again once it is turned back on. Turning it off deletes nothing (bindings, queued actions and
// connected accounts are kept) and turning it on creates nothing: it restores only what still
// exists. A flag is never a grant.

import { InferOpsError, type InferOpsClient } from "./inferops-client";

/** The message every refused call carries after its `DISABLED: ` code. */
export const DISABLED_MESSAGE = "InferOps is turned off for this deployment.";

/**
 * Whether the deployment has the InferOps integration on. Unset counts as on, so a deployment
 * that predates the switch (the committed wrangler.jsonc, the cloud release) keeps working; the
 * dev server always sets it, from the wrapper's resolved configuration. Any value other than
 * `"true"` is off, so a mistyped value fails closed.
 */
export function inferOpsEnabled(env: Pick<Cloudflare.Env, "INFEROPS_ENABLED">): boolean {
  return env.INFEROPS_ENABLED === undefined || env.INFEROPS_ENABLED === "true";
}

/** Throw `DISABLED` while the integration is off. */
export function assertInferOpsEnabled(env: Pick<Cloudflare.Env, "INFEROPS_ENABLED">): void {
  if (!inferOpsEnabled(env)) throw new InferOpsError("DISABLED", DISABLED_MESSAGE);
}

/**
 * A client that checks the switch before every call and opens the real one only once a call is
 * allowed. Every method is guarded, including ones added later, except `forget`: deleting an
 * account's own data must stay possible while the integration is off.
 */
export function whileInferOpsEnabled(
  env: Pick<Cloudflare.Env, "INFEROPS_ENABLED">, open: () => InferOpsClient,
): InferOpsClient {
  return guarded(() => assertInferOpsEnabled(env), open);
}

/**
 * A proxy over the client that runs `check` before every call except `forget`, opening the real
 * client only once a call is allowed. Shared by the integration switch and the coding switch.
 */
export function guarded(check: () => void, open: () => InferOpsClient): InferOpsClient {
  let client: InferOpsClient | undefined;
  const inner = () => (client ??= open());
  return new Proxy({} as InferOpsClient, {
    get(_target, method) {
      // Not a thenable, and nothing else but the client's own methods.
      if (typeof method !== "string" || method === "then") return undefined;
      if (method === "forget") return () => inner().forget();
      return async (...args: unknown[]) => {
        check();
        const target = inner() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
        const call = target[method];
        if (typeof call !== "function") throw new TypeError(`InferOpsClient has no method ${method}`);
        return call.apply(target, args);
      };
    },
  });
}
