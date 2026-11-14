/// <reference types="@cloudflare/vitest-plugin/types" />

import type { SignInAttempt } from "../src/worker.js";
import type { TestHooks } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      // Declared only in vitest.config.ts.
      SIGN_IN_ATTEMPT: DurableObjectNamespace<SignInAttempt>;
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
    }
  }
}
