import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";

/**
 * Form state of the project-board picker. The URL it builds is
 * `inferops://<tenant>.<workspace>/project/board/<projectKey>`.
 */
export type InferOpsProjectConfiguratorValues = {
  /** The tenant (organization) slug: the URL's first label. Labels the address; authorizes nothing. */
  tenant?: string | null;
  /** The workspace slug: the URL's second label, one of the person's own workspaces. */
  workspace?: string | null;
  /** Selected project key, such as ENG. */
  projectKey?: string | null;
};

/** The narrow capability the picker iframe receives. */
export interface InferOpsProjectConfiguratorRpc {
  /**
   * The host a new binding names when the form leaves tenant and workspace empty: `demo.local` for
   * an account that serves demo data, null when the person must name both.
   */
  defaultHost(): Promise<string | null>;
  /** Projects the connected account can open on `host` (`<tenant>.<workspace>`), filtered by `query`. */
  listProjects(query: string, host: string): Promise<ConfiguratorUIOption[]>;
  /** The workspaces a URL may name for this account, valued by slug; empty for demo data. */
  listWorkspaces(): Promise<ConfiguratorUIOption[]>;
}
