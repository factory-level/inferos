// Project-specific ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface GlobalProps {
    // Populates Cloudflare.Exports, the type of ctx.exports.
    mainModule: typeof import("./inferops.js");
    // Durable Object classes exposed as namespaces on ctx.exports.
    durableNamespaces: "MockInferOps" | "InferOpsProjectGatekeeper";
  }
}
