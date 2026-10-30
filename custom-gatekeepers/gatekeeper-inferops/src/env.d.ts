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
     * Optional bare origin the browser is sent to for InferLab's `/authorize` instead of
     * `INFERLAB_AUTH_ORIGIN`: a hostname routed to this gatekeeper, which forwards the sign-in pages
     * to InferLab (auth-proxy.ts). Must sit behind the deployment's Access application. Set but
     * malformed, sign-in is off.
     */
    INFERLAB_AUTHORIZE_ORIGIN?: string;
    /**
     * A secret, not a var: the shared value InferLab's edge (an IP-allowlisting WAF) lets through
     * in the `x-inferos-edge` header. Set, every request to `INFERLAB_AUTH_ORIGIN` and
     * `INFEROPS_BASE_URL` carries it, and no other request does (see edge-header.ts). Unset, no
     * header is sent.
     */
    INFEROPS_EDGE_SECRET?: string;
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
     * `"true"` or `"false"`: whether custom-table bindings are on (capability
     * `INFEROPS_TABLES_ENABLED`). Unset counts as off (see table.ts); it also needs `INFEROPS_ENABLED`.
     */
    INFEROPS_TABLES_ENABLED?: string;
    /**
     * `"true"` or `"false"`: whether workspace-member bindings are on (capability
     * `INFEROPS_MEMBERS_ENABLED`). Unset counts as off (see members.ts); it also needs `INFEROPS_ENABLED`.
     */
    INFEROPS_MEMBERS_ENABLED?: string;
    /**
     * `"true"` or `"false"`: whether workflow-policy bindings are on (`INFEROPS_WORKFLOW_POLICY_ENABLED`).
     * Unset counts as off (see workflow-policy.ts); it also needs `INFEROPS_ENABLED`.
     */
    INFEROPS_WORKFLOW_POLICY_ENABLED?: string;
    /**
     * `"true"` or `"false"`: whether the kernel-only host-board read is on (`INFEROPS_HOST_BOARDS`,
     * a proposed extension of the capability vocabulary). Unset counts as off (see host-board.ts);
     * it also needs `INFEROPS_ENABLED`. Nothing sets it yet: no dev-server, wrapper or release
     * resolution reads it.
     */
    INFEROPS_HOST_BOARDS?: string;
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
