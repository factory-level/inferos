// Project-specific ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  // Local-development stopgap for a live InferOps connection (see http-inferops.ts): unset in the
  // committed wrangler.jsonc and passed through by `pnpm dev-server`. inferos#66 replaces the
  // token with each connected person's own credential.
  interface Env {
    INFEROPS_BASE_URL?: string;
    INFEROPS_API_TOKEN?: string;
    INFEROPS_WORKSPACE_ID?: string;
  }

  interface GlobalProps {
    // Populates Cloudflare.Exports, the type of ctx.exports.
    mainModule: typeof import("./inferops.js");
    // Durable Object classes exposed as namespaces on ctx.exports.
    durableNamespaces: "MockInferOps" | "InferOpsProjectGatekeeper" | "InferLabLogin";
  }

  // Deployment vars the committed wrangler.jsonc deliberately leaves unset.
  interface Env {
    /** This gatekeeper's public URL, `<PUBLIC_BASE_URL>/gatekeeper/inferops`. */
    BASE_URL?: string;
    /** InferLab central-auth origin; setting it turns on "Sign in with InferLab". */
    INFERLAB_AUTH_ORIGIN?: string;
  }
}
