/**
 * Workspace and page configuration (FAC-95): a small fixed registry of settings, each with the same
 * shape at both levels, so "a workspace-wide setting" and "a page override" differ only in where a
 * value sits. A workspace keeps its settings in one revisioned record (`WorkspaceConfiguration`); a
 * nested page may override any of them (`CanvasPage.settings`, the one override ADR 0014 now
 * allows); otherwise a setting takes its default. Nothing here grants authority: a setting decides
 * presentation, and every action still needs the person's own grant and approval (FAC-92).
 */

/** Each setting's key, value type, default, and what it permits, in plain words. */
export const WORKSPACE_SETTINGS = {
  /** Whether widgets may ask the host to draw an alert. No alert is drawn yet; this records the choice. */
  "baseUi.alerts": {
    values: [false, true] as const,
    default: false,
    permits: "Widgets may ask the host to show an alert. It grants nothing.",
  },
  /**
   * Whether widgets may raise a notification. Delivery isn't defined (FAC-114 left destinations
   * open), so this records the choice and its owner only.
   */
  "baseUi.notifications": {
    values: [false, true] as const,
    default: false,
    permits: "Widgets may raise a notification, recorded for the operator; nothing is delivered yet. It grants nothing.",
  },
  /** Which widgets the operate chat pane may open: the ones the console offers, or none. */
  "chatPane.widgets": {
    values: ["console", "none"] as const,
    default: "console",
    permits: "Which of the console's widgets the chat pane may open. It grants nothing.",
  },
} as const;

/** A setting's key. */
export type WorkspaceSettingKey = keyof typeof WORKSPACE_SETTINGS;

/** Every setting key, in registry order. */
export const WORKSPACE_SETTING_KEYS = Object.keys(WORKSPACE_SETTINGS) as WorkspaceSettingKey[];

/** A setting's value. */
export type WorkspaceSettingValue<K extends WorkspaceSettingKey> = (typeof WORKSPACE_SETTINGS)[K]["values"][number];

/** Some settings, each a registry key with one of its values. A missing key means "not set here". */
export type WorkspaceSettings = { [K in WorkspaceSettingKey]?: WorkspaceSettingValue<K> };

/** A workspace's configuration: its settings, at a decimal revision raised by one on each change. */
export type WorkspaceConfiguration = {
  /** Decimal revision, "0" before the first save. */
  revision: string;
  settings: WorkspaceSettings;
};

/** The configuration of a workspace that has never saved one. */
export const EMPTY_WORKSPACE_CONFIGURATION: WorkspaceConfiguration = Object.freeze({ revision: "0", settings: Object.freeze({}) });

/**
 * Validate and detach some settings: an object of registry keys, each with one of its values.
 * Throws a `TypeError` naming the first unknown key or invalid value, so nothing is half-applied.
 */
export function parseWorkspaceSettings(value: unknown): WorkspaceSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Settings must be an object.");
  let result: Record<string, unknown> = {};
  for (let [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(WORKSPACE_SETTINGS, key)) throw new TypeError(`Unknown setting "${key}".`);
    let allowed: readonly unknown[] = WORKSPACE_SETTINGS[key as WorkspaceSettingKey].values;
    if (!allowed.includes(raw)) {
      throw new TypeError(`Setting "${key}" must be one of ${allowed.map(item => JSON.stringify(item)).join(", ")}.`);
    }
    result[key] = raw;
  }
  return result as WorkspaceSettings;
}

/** Where a setting's effective value comes from. */
export type WorkspaceSettingOwner = "page" | "workspace" | "default";

/** A setting as one page sees it: its value and the level that owns it. */
export type ResolvedWorkspaceSetting<K extends WorkspaceSettingKey = WorkspaceSettingKey> = {
  key: K;
  value: WorkspaceSettingValue<K>;
  owner: WorkspaceSettingOwner;
  /** What it permits, in plain words. */
  permits: string;
};

/** Setting `key` for a page: the page's override, else the workspace's value, else the default. */
export function resolveWorkspaceSetting<K extends WorkspaceSettingKey>(key: K, workspace: WorkspaceSettings,
    page?: WorkspaceSettings): ResolvedWorkspaceSetting<K> {
  let permits = WORKSPACE_SETTINGS[key].permits;
  if (page && page[key] !== undefined) return { key, value: page[key]!, owner: "page", permits };
  if (workspace[key] !== undefined) return { key, value: workspace[key]!, owner: "workspace", permits };
  return { key, value: WORKSPACE_SETTINGS[key].default as WorkspaceSettingValue<K>, owner: "default", permits };
}

/** Every setting for a page, in registry order. */
export function resolveWorkspaceSettings(workspace: WorkspaceSettings, page?: WorkspaceSettings): ResolvedWorkspaceSetting[] {
  return WORKSPACE_SETTING_KEYS.map(key => resolveWorkspaceSetting(key, workspace, page));
}
