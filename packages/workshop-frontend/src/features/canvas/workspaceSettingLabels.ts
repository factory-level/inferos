import type { WorkspaceSettingKey, WorkspaceSettingOwner } from '@gadgets/workshop-shared/workspace-settings'

/** Each setting's name, as the builder sees it. */
export const SETTING_LABELS: Record<WorkspaceSettingKey, string> = {
  'baseUi.alerts': 'Widget alerts',
  'baseUi.notifications': 'Widget notifications',
  'chatPane.widgets': 'Chat pane widgets',
}

/** A setting value in words. */
export const settingValueLabel = (value: boolean | string): string =>
  value === true ? 'On' : value === false ? 'Off' : value === 'console' ? 'The console’s widgets' : value === 'none' ? 'None' : String(value)

/** Who a setting's value comes from, in words: what tells a workspace setting from a page override. */
export const SETTING_OWNER_LABELS: Record<WorkspaceSettingOwner, string> = {
  page: 'Overridden on this page',
  workspace: 'Workspace setting',
  default: 'Default',
}
