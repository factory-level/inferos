import { describe, expect, it } from "vitest";
import { assertAuthGatekeepersConfigured } from "../src/auth/config.js";

/** An env with the given sign-in allowlist and gatekeeper bindings, each answering `describe()`. */
function envWith(allowlist: string | undefined, vendors: Record<string, { providesAuth: boolean }>) {
  const env: Record<string, unknown> = { AUTH_GATEKEEPERS: allowlist };
  for (const [vendorId, description] of Object.entries(vendors)) {
    env[`GATEKEEPER_${vendorId.toUpperCase()}`] = { describe: async () => description };
  }
  return env as unknown as Cloudflare.Env;
}

describe("assertAuthGatekeepersConfigured", () => {
  it("passes with no allowlist, and with every listed vendor bound and providing sign-in", async () => {
    await assertAuthGatekeepersConfigured(envWith(undefined, {}));
    await assertAuthGatekeepersConfigured(envWith("", { inferops: { providesAuth: false } }));
    await assertAuthGatekeepersConfigured(envWith("google, InferOps", {
      google: { providesAuth: true }, inferops: { providesAuth: true },
    }));
  });

  it("names a listed vendor that is not bound", async () => {
    await expect(assertAuthGatekeepersConfigured(envWith("inferops", {})))
      .rejects.toThrow('AUTH_GATEKEEPERS lists "inferops", but no gatekeeper is bound as GATEKEEPER_INFEROPS.');
  });

  it("names a listed vendor that is bound but not configured for sign-in", async () => {
    await expect(assertAuthGatekeepersConfigured(envWith("google,inferops", {
      google: { providesAuth: true }, inferops: { providesAuth: false },
    }))).rejects.toThrow('AUTH_GATEKEEPERS lists "inferops", but that gatekeeper is not configured to provide sign-in');
  });
});
