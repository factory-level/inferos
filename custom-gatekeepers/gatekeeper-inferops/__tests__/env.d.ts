/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Test-only bindings, declared in `vitest.config.ts` rather than `wrangler.jsonc`, so they are absent
// from the generated `worker-configuration.d.ts`.

import type { MockInferOps, TestHooks } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      MOCK_INFEROPS: DurableObjectNamespace<MockInferOps>;
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
    }
  }
}
