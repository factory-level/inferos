type UiFeatureFlagDefinition = {
  key: string;
  dev: boolean;
  default: boolean;
};

/** UI feature flags resolved by `workshop-backend` for `workshop-frontend`. */
export const UI_FEATURE_FLAGS = [
  // Home chat layouts. With none on, Home is the plain chat launcher. If several are on, the first
  // in this order wins (see `resolveChatLayout` in workshop-frontend).
  { key: "chat-layout-dashboard", dev: false, default: false },
  { key: "chat-layout-thread", dev: false, default: false },
  { key: "chat-layout-copilot", dev: false, default: false },
  { key: "openai-chatgpt-plan-usage", dev: false, default: false },
] as const satisfies readonly UiFeatureFlagDefinition[];

type UiFeatureFlag = (typeof UI_FEATURE_FLAGS)[number];

/** Valid keys accepted by `useUiFeatureFlag()`. */
export type UiFeatureFlagName = UiFeatureFlag["key"];

/** Resolved boolean values for every registered UI feature flag. */
export type UiFeatureFlags = Record<UiFeatureFlagName, boolean>;

/** Flag values used by local Workshop development. */
export const DEV_UI_FEATURE_FLAGS = Object.fromEntries(
  UI_FEATURE_FLAGS.map((flag) => [flag.key, flag.dev] as const),
) as UiFeatureFlags;

/** Flag values used when Flagship is unavailable or unconfigured. */
export const DEFAULT_UI_FEATURE_FLAGS = Object.fromEntries(
  UI_FEATURE_FLAGS.map((flag) => [flag.key, flag.default] as const),
) as UiFeatureFlags;
