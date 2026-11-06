import { EMPTY_WORKSPACE_CONFIGURATION, parseWorkspaceSettings, type WorkspaceConfiguration } from "@gadgets/workshop-shared/workspace-settings";
import type { OverseerStorage } from "./overseer";

/** The refusal when the workspace's configuration moved past the revision a save expected. */
export const WORKSPACE_CONFIGURATION_CHANGED =
  "The workspace's settings changed since you opened them; reload them and try again.";

/** The workspace's configuration: its settings at their revision, "0" before the first save. */
export function readWorkspaceConfiguration(storage: Pick<OverseerStorage, "workspaceConfiguration">): WorkspaceConfiguration {
  return storage.workspaceConfiguration.get() ?? EMPTY_WORKSPACE_CONFIGURATION;
}

/**
 * Replace the workspace's settings (FAC-95) if `expectedRevision` is current, and return the new
 * configuration at the next revision. `settings` must be registry keys with their values
 * (`parseWorkspaceSettings`); anything else is refused, as is a stale revision, and nothing is
 * written. Synchronous, so the check and the write are one step. Who may call it is the caller's
 * to decide: the build role, behind the deployment's shared-configuration check.
 */
export function saveWorkspaceConfiguration(storage: Pick<OverseerStorage, "workspaceConfiguration">,
    expectedRevision: string, settings: unknown): WorkspaceConfiguration {
  let parsed = parseWorkspaceSettings(settings);
  let current = readWorkspaceConfiguration(storage);
  if (current.revision !== expectedRevision) throw new Error(WORKSPACE_CONFIGURATION_CHANGED);
  let next: WorkspaceConfiguration = { revision: (BigInt(current.revision) + 1n).toString(), settings: parsed };
  storage.workspaceConfiguration.put(next);
  return next;
}
