import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * The workerd suite: sessions are `RpcTarget`s handed out by a Durable Object facet carrying
 * `ctx.props`, and the data source is a Durable Object, so none of it runs in Node.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        // Sign-in is on in this suite; the unset case is covered by `inferLabAuthOrigin` directly.
        bindings: {
          INFERLAB_AUTH_ORIGIN: "http://localhost:8080",
          BASE_URL: "http://localhost:8787/gatekeeper/inferops",
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
          // One sign-in attempt per object; the tests seed its callback from inside the object.
          INFERLAB_LOGIN: { className: "InferLabLogin", useSQLite: true },
          // One per connected account; the tests reach it through the account entrypoints.
          INFEROPS_CREDENTIALS: { className: "InferOpsCredentials", useSQLite: true },
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
