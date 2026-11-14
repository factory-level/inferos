import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * The workerd suite: the sign-in flow end to end against a fake InferLab (fake-inferlab.ts), with
 * the attempt Durable Object driven through `TestHooks` (worker.ts). The `@validateRpc()`
 * decorators are applied in-memory by the capnweb-validate plugin.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        durableObjects: {
          SIGN_IN_ATTEMPT: { className: "SignInAttempt", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
        bindings: {
          INFERLAB_AUTH_ORIGIN: "http://localhost:23380",
          INFEROPS_COMPANY: "00000000-0000-4000-8000-000000000001",
          BASE_URL: "http://localhost:8787/gatekeeper/inferlab",
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
