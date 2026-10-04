// Project-specific ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  // The InferOps API (see http-inferops.ts): unset in the committed wrangler.jsonc and passed
  // through by `pnpm dev-server`. INFEROPS_BASE_URL names the API connected people call with their
  // own session; the token, workspace id and workspace slug are the local-development stopgap
  // connection shared by every account that has no identity.
  interface Env {
    INFEROPS_BASE_URL?: string;
    INFEROPS_API_TOKEN?: string;
    INFEROPS_WORKSPACE_ID?: string;
    INFEROPS_WORKSPACE_SLUG?: string;
  }

  interface GlobalProps {
    // Populates Cloudflare.Exports, the type of ctx.exports.
    mainModule: typeof import("./inferops.js");
    // Durable Object classes exposed as namespaces on ctx.exports.
    durableNamespaces: "MockInferOps" | "InferOpsProjectGatekeeper" | "InferOpsDispatchGatekeeper" |
      "InferOpsWikiGatekeeper" | "InferLabLogin" | "InferOpsCredentials";
  }

  // Deployment vars the committed wrangler.jsonc deliberately leaves unset.
  interface Env {
    /** This gatekeeper's public URL, `<PUBLIC_BASE_URL>/gatekeeper/inferops`. */
    BASE_URL?: string;
    /**
     * InferLab central-auth origin. Setting it turns on "Sign in with InferLab" and makes every
     * InferOps account a person's own InferLab session instead of an auto-provisioned demo account.
     */
    INFERLAB_AUTH_ORIGIN?: string;
    /**
     * `"true"` or `"false"`: whether the InferOps integration is on (capability `INFEROPS_ENABLED`).
     * The dev server always sets it; unset counts as on (see enablement.ts).
     */
    INFEROPS_ENABLED?: string;
    /**
     * `"true"` or `"false"`: whether coding dispatch is on (capability `CODING_WORKBENCH_ENABLED`).
     * Unset counts as off (see enablement.ts); it also needs `INFEROPS_ENABLED`.
     */
    CODING_WORKBENCH_ENABLED?: string;
    /**
     * The InferOps repository ids the wrapper's `codingWorkbench.repos` allowlists, comma-separated.
     * Ids only, never local paths. Unset allows no repository.
     */
    CODING_WORKBENCH_REPOS?: string;
    /**
     * Development only (#28): a whole number from 1 to 2000 adds a synthetic `PERF` project of that
     * many issues to each mock account's data when it is first seeded (see mock-inferops.ts).
     */
    MOCK_INFEROPS_SYNTHETIC_ISSUES?: string;
  }
}
