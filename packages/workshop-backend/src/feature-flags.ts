import {
  DEFAULT_UI_FEATURE_FLAGS,
  DEV_UI_FEATURE_FLAGS,
  UI_FEATURE_FLAGS,
  type UiFeatureFlagName,
  type UiFeatureFlags,
} from "@gadgets/workshop-shared/feature-flags";
import { createWorkshopLogger } from "./observability";
import { isOpenAiPluginEnabled } from '@gadgets/assistant-plugin-openai/protocol';

const logger = createWorkshopLogger("workshop.feature-flags");

type FeatureFlagEnv = {
  ENABLE_OPENAI_ASSISTANT_PLUGIN?: string;
  OPENAI_ASSISTANT_PLUGIN_URL?: string;
  OPENAI_ASSISTANT_PLUGIN_SECRET?: string;
  DEV?: boolean;
  FLAGS?: Pick<Flagship, "getBooleanValue">;
};

type UiFeatureFlagEntry = [UiFeatureFlagName, boolean];

export async function resolveUiFeatureFlags(
    env: FeatureFlagEnv,
    userId: string,
): Promise<UiFeatureFlags> {
  const deploymentFlags = { 'openai-chatgpt-plan-usage': isOpenAiPluginEnabled(env) };
  if (env.DEV) {
    return { ...DEV_UI_FEATURE_FLAGS, ...deploymentFlags };
  }

  const flags = env.FLAGS;
  if (!flags) {
    logger.warn("Flagship binding missing; using default values", {
      event: "feature-flags.binding.missing",
      operation: "feature-flags.resolve",
    });
    return { ...DEFAULT_UI_FEATURE_FLAGS, ...deploymentFlags };
  }

  const values: UiFeatureFlagEntry[] = await Promise.all(
    UI_FEATURE_FLAGS.map(async (flag): Promise<UiFeatureFlagEntry> => {
      if (flag.key === 'openai-chatgpt-plan-usage') return [flag.key, deploymentFlags[flag.key]];
      try {
        return [flag.key, await flags.getBooleanValue(flag.key, flag.default, { userId })];
      } catch (error) {
        logger.warn("feature flag evaluation failed", {
          event: "feature-flags.evaluate.failed",
          operation: "feature-flags.evaluate",
          error,
        });
        return [flag.key, flag.default];
      }
    }),
  );

  return { ...Object.fromEntries(values), ...deploymentFlags } as UiFeatureFlags;
}
