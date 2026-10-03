// Project-specific ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
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
