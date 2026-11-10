import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

// capnweb-validate decides what to transform by the id with its query stripped, so it also takes
// `foo.ts?raw`, whose code is vite's `export default "<source>"`, and splices edits whose offsets
// come from the file's TypeScript source into that string. edge-header.test.ts reads `src/` through
// `?raw` to scan what is on disk, so those ids are left untransformed, as workshop-backend's
// `rpcValidation` does; every other module is validated as before.
const STRING_QUERY = /[?&](?:raw|url|inline)(?:[&=]|$)/;
function rpcValidation(): Plugin {
  const plugin = capnwebValidate() as Plugin;
  const hook = plugin.transform;
  const transform = typeof hook === "function" ? hook : hook?.handler;
  if (!transform) throw new Error("capnweb-validate has no transform hook to wrap");
  const wrapped: typeof transform = function (code, id, options) {
    return STRING_QUERY.test(id) ? null : transform.call(this, code, id, options);
  };
  return { ...plugin, transform: typeof hook === "function" ? wrapped : { ...hook, handler: wrapped } };
}

/**
 * The workerd suite: sessions are `RpcTarget`s handed out by a Durable Object facet carrying
 * `ctx.props`, and the data source is a Durable Object, so none of it runs in Node.
 */
export default defineConfig({
  plugins: [
    rpcValidation(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        // Sign-in is on in this suite; the unset case is covered by `inferLabAuthOrigin` directly.
        bindings: {
          INFERLAB_AUTH_ORIGIN: "http://localhost:8080",
          BASE_URL: "http://localhost:8787/gatekeeper/inferops",
          // Opt-in reproduction of a loaded runner for account.test.ts, off unless set: delays the
          // revoke test's snapshot requests by this many ms. Only a direct `pnpm test:run` sees it;
          // a cached `vp run` strips undeclared variables, so it can never switch on there.
          GK_REPRO_DELAY_MS: process.env.GK_REPRO_DELAY_MS ?? "",
        },
        durableObjects: {
          // Direct access to an account's mock data, to change it behind the gatekeeper's back.
          MOCK_INFEROPS: { className: "MockInferOps", useSQLite: true },
          // Declared so the class is a Durable Object class here, as the generated wrangler.jsonc's
          // migrations make it in production; the tests reach it only through ctx.facets.
          PROJECT_GATEKEEPER: { className: "InferOpsProjectGatekeeper", useSQLite: true },
          // The same, with a test-only hook for writing raw action records; `TestHooks` drives it.
          TEST_PROJECT_GATEKEEPER: { className: "TestProjectGatekeeper", useSQLite: true },
          // The coding-dispatch gatekeeper, the same way: declared, and driven through `TestHooks`.
          DISPATCH_GATEKEEPER: { className: "InferOpsDispatchGatekeeper", useSQLite: true },
          TEST_DISPATCH_GATEKEEPER: { className: "TestDispatchGatekeeper", useSQLite: true },
          // The Wiki gatekeeper, the same way.
          WIKI_GATEKEEPER: { className: "InferOpsWikiGatekeeper", useSQLite: true },
          TEST_WIKI_GATEKEEPER: { className: "TestWikiGatekeeper", useSQLite: true },
          // The custom-table gatekeeper, the same way.
          TABLE_GATEKEEPER: { className: "InferOpsTableGatekeeper", useSQLite: true },
          // The workspace-members gatekeeper, the same way.
          MEMBERS_GATEKEEPER: { className: "InferOpsMembersGatekeeper", useSQLite: true },
          // The workflow-policy gatekeeper, the same way.
          WORKFLOW_POLICY_GATEKEEPER: { className: "InferOpsWorkflowPolicyGatekeeper", useSQLite: true },
          // The Dot gatekeeper, the same way (FAC-133).
          DOT_GATEKEEPER: { className: "InferOpsDotGatekeeper", useSQLite: true },
          // The account gatekeeper, the same way, with raw storage access through `TestHooks`.
          ACCOUNT_GATEKEEPER: { className: "InferOpsAccountGatekeeper", useSQLite: true },
          TEST_ACCOUNT_GATEKEEPER: { className: "TestAccountGatekeeper", useSQLite: true },
          // One sign-in attempt per object; the tests seed its callback from inside the object.
          INFERLAB_LOGIN: { className: "InferLabLogin", useSQLite: true },
          // One per connected account; the tests reach it through the account entrypoints.
          INFEROPS_CREDENTIALS: { className: "InferOpsCredentials", useSQLite: true },
          // One per system workflow assignment's key (FAC-102); reached through the vendor.
          INFEROPS_SYSTEM_CREDENTIALS: { className: "InferOpsSystemCredentials", useSQLite: true },
          // A facet carrying props is only reachable through `ctx.facets`, so the tests drive the
          // gatekeeper from a hook Durable Object, as the overseer does in production.
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
    // A file's first test also pays for starting its Durable Objects and facets in workerd, which on
    // a loaded CI runner has taken longer than vitest's 5s default.
    testTimeout: 20_000,
  },
});
