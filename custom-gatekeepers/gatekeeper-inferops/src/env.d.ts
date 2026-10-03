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
    durableNamespaces: "MockInferOps" | "InferOpsProjectGatekeeper" | "InferLabLogin" | "InferOpsCredentials";
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
  }
}
