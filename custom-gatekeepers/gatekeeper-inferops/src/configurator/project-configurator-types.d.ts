import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";

/** Form state of the project-board picker. */
export type InferOpsProjectConfiguratorValues = {
  /** InferOps host; kept from a prefilled URL, otherwise null for the account's default host. */
  host?: string | null;
  /** Selected project key, such as DEMO. */
  projectKey?: string | null;
  /** The InferOps workspace to look in; null for the account's only one. */
  workspaceId?: string | null;
};

/** The narrow capability the picker iframe receives. */
export interface InferOpsProjectConfiguratorRpc {
  /** The InferOps host a new binding names when none was prefilled. */
  defaultHost(): Promise<string>;
  /** Projects the connected account can open on `host` (the default host if omitted), filtered by `query`. */
  listProjects(query: string, host?: string): Promise<ConfiguratorUIOption[]>;
  /** The InferOps workspaces the connected person belongs to; empty for a demo account. */
  listWorkspaces(): Promise<ConfiguratorUIOption[]>;
  /** Chooses the workspace new bindings are made in; null returns to the only one. */
  selectWorkspace(workspaceId: string | null): Promise<void>;
}
