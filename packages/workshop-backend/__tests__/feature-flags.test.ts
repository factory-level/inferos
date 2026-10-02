import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UI_FEATURE_FLAGS,
  DEV_UI_FEATURE_FLAGS,
  UI_FEATURE_FLAGS,
} from "@gadgets/workshop-shared/feature-flags";
import { resolveUiFeatureFlags } from "../src/feature-flags.js";

const TEST_USER_ID = "test-user";

describe("resolveUiFeatureFlags", () => {
  it("uses default values when Flagship is not configured", async () => {
    await expect(resolveUiFeatureFlags({}, TEST_USER_ID)).resolves.toEqual(DEFAULT_UI_FEATURE_FLAGS);
  });

  it("uses development values without evaluating Flagship", async () => {
    const getBooleanValue = vi.fn();
    const env = { DEV: true, FLAGS: { getBooleanValue } };

    await expect(resolveUiFeatureFlags(env, TEST_USER_ID)).resolves.toEqual(DEV_UI_FEATURE_FLAGS);
    expect(getBooleanValue).not.toHaveBeenCalled();
  });

  it("evaluates rollout flags but does not let Flagship enable local ChatGPT billing", async () => {
    const getBooleanValue = vi.fn().mockResolvedValue(true);
    const env = { FLAGS: { getBooleanValue } };

    await expect(resolveUiFeatureFlags(env, TEST_USER_ID)).resolves.toEqual(
      Object.fromEntries(UI_FEATURE_FLAGS.map((flag) => [flag.key, flag.key !== 'openai-chatgpt-plan-usage'])),
    );
    expect(getBooleanValue).toHaveBeenCalledTimes(UI_FEATURE_FLAGS.length - 1);
    for (const flag of UI_FEATURE_FLAGS.filter(flag => flag.key !== 'openai-chatgpt-plan-usage')) {
      expect(getBooleanValue).toHaveBeenCalledWith(
        flag.key,
        flag.default,
        { userId: TEST_USER_ID },
      );
    }
  });

  it('requires the deployment flag and a configured loopback companion', async () => {
    const env = { ENABLE_OPENAI_ASSISTANT_PLUGIN: 'true', OPENAI_ASSISTANT_PLUGIN_URL: 'http://127.0.0.1:1234',
      OPENAI_ASSISTANT_PLUGIN_SECRET: 'bridge-secret' };
    expect((await resolveUiFeatureFlags(env, TEST_USER_ID))['openai-chatgpt-plan-usage']).toBe(true);
    expect((await resolveUiFeatureFlags({ ...env, ENABLE_OPENAI_ASSISTANT_PLUGIN: undefined }, TEST_USER_ID))['openai-chatgpt-plan-usage']).toBe(false);
  });

  it("uses a flag default when evaluation throws", async () => {
    const getBooleanValue = vi.fn().mockRejectedValue(new Error("Flagship unavailable"));
    const env = { FLAGS: { getBooleanValue } };

    await expect(resolveUiFeatureFlags(env, TEST_USER_ID)).resolves.toEqual(DEFAULT_UI_FEATURE_FLAGS);
  });
});
