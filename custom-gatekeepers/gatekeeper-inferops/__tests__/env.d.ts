/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Test-only bindings, declared in `vitest.config.ts` rather than `wrangler.jsonc`, so they are absent
// from the generated `worker-configuration.d.ts`.

import type { InferLabLogin, MockInferOps, TestHooks } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      MOCK_INFEROPS: DurableObjectNamespace<MockInferOps>;
      INFERLAB_LOGIN: DurableObjectNamespace<InferLabLogin>;
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
    }
  }
}
