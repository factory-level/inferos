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
      Object.fromEntries(UI_FEATURE_FLAGS.map((flag) => [flag.key,
        flag.key !== 'openai-chatgpt-plan-usage' && flag.key !== 'authored-widgets'])),
    );
    expect(getBooleanValue).toHaveBeenCalledTimes(UI_FEATURE_FLAGS.length - 2);
    for (const featureFlag of UI_FEATURE_FLAGS.filter(item => item.key !== 'openai-chatgpt-plan-usage' && item.key !== 'authored-widgets')) {
      expect(getBooleanValue).toHaveBeenCalledWith(
        featureFlag.key,
        featureFlag.default,
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

  it("exposes authored-widget builds only when the deployment variable is exactly true", async () => {
    const getBooleanValue = vi.fn().mockResolvedValue(true);
    const base = { FLAGS: { getBooleanValue } };
    expect((await resolveUiFeatureFlags(base, TEST_USER_ID))["authored-widgets"]).toBe(false);
    expect((await resolveUiFeatureFlags({ ...base, AUTHORED_WIDGET_BUILD_ENABLED: "True" }, TEST_USER_ID))["authored-widgets"]).toBe(false);
    expect((await resolveUiFeatureFlags({ ...base, AUTHORED_WIDGET_BUILD_ENABLED: "true" }, TEST_USER_ID))["authored-widgets"]).toBe(true);
    expect(getBooleanValue).not.toHaveBeenCalledWith("authored-widgets", expect.anything(), expect.anything());
  });

  it("uses the deployment value in DEV without evaluating Flagship", async () => {
    const getBooleanValue = vi.fn();
    const flags = { DEV: true, FLAGS: { getBooleanValue }, AUTHORED_WIDGET_BUILD_ENABLED: "true" };
    expect((await resolveUiFeatureFlags(flags, TEST_USER_ID))["authored-widgets"]).toBe(true);
    expect(getBooleanValue).not.toHaveBeenCalled();
  });

  it("uses a flag default when evaluation throws", async () => {
    const getBooleanValue = vi.fn().mockRejectedValue(new Error("Flagship unavailable"));
    const env = { FLAGS: { getBooleanValue } };

    await expect(resolveUiFeatureFlags(env, TEST_USER_ID)).resolves.toEqual(DEFAULT_UI_FEATURE_FLAGS);
  });
});
