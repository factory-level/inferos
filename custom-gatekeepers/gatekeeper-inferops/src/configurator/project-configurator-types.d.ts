import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";

/** Form state of the project-board picker. */
export type InferOpsProjectConfiguratorValues = {
  /** InferOps host; kept from a prefilled URL, otherwise the default host. */
  host?: string | null;
  /** Selected project key, such as DEMO. */
  projectKey?: string | null;
};

/** The narrow capability the picker iframe receives. */
export interface InferOpsProjectConfiguratorRpc {
  /** Projects the connected account can open, filtered by `query`. */
  listProjects(query: string): Promise<ConfiguratorUIOption[]>;
}
