// The resource-URL grammar, InferOps' own (`_libs/widgets/shared/inferops-uri.ts`):
// `inferops://<tenant>.<workspace>/project/board/<KEY>`. A URL names a target; it never grants
// anything by itself, and it never names a deployment: the API base URL and the credentials come
// from the account and the deployment's configuration. The gatekeeper resolves the workspace slug
// against the person's own workspaces, binds the result into its props when the Workshop mints the
// capability, and every later call reads scope from those props only. The tenant label is checked
// for syntax and kept in the URL, but authorizes nothing (see `parseProjectBoardUrl`).

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

/** The host of the built-in demo data, and the only one the mock serves. Never an InferOps tenant. */
export const DEMO_HOST = "demo.local";

/** One project board, the only grantable resource type. */
export const PROJECT_BOARD_RESOURCE: SupportedResource = {
  urlPattern: "inferops://*/project/board/*",
  title: "InferOps project board",
  description:
    "Read one InferOps project's board and propose moving its issues between workflow states.",
};

/**
 * A parsed project-board resource URL. `host` is `<tenant>.<workspace>`, the URL's authority, kept
 * whole because bindings and the mock are keyed by it.
 */
export type ProjectBoardRef = { host: string; tenant: string; workspace: string; projectKey: string };

// Project keys: an uppercase letter, then uppercase letters or digits. InferOps itself accepts
// mixed case (see the design's Open Questions); such a project is listed but cannot be bound.
const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,15}$/;
// A tenant or workspace slug as InferOps stores one (`slugify`): lowercase letters and digits with
// interior hyphens, at most 63 characters.
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Whether `value` is a tenant or workspace slug InferOps could have issued. */
export function isSlug(value: string): boolean {
  return SLUG.test(value);
}

/** Splits `<tenant>.<workspace>` into its labels, or returns null when it is not exactly that. */
export function parseHost(host: string): { tenant: string; workspace: string } | null {
  const labels = host.split(".");
  if (labels.length !== 2 || !labels.every(isSlug)) return null;
  return { tenant: labels[0]!, workspace: labels[1]! };
}

/**
 * Parse a project-board URL, or throw a message naming the expected form. Only syntax is checked:
 * exactly two lowercase slug labels, no port, no user info. Whether the workspace is the caller's
 * is decided by the account; the tenant label is never trusted for anything.
 */
export function parseProjectBoardUrl(url: string): ProjectBoardRef {
  const match = /^inferops:\/\/([^/?#]+)\/project\/board\/([^/?#]+)\/?$/.exec(url.trim());
  const host = match?.[1];
  const projectKey = match?.[2];
  const labels = host ? parseHost(host) : null;
  if (!host || !labels || !projectKey || !PROJECT_KEY.test(projectKey)) {
    throw new Error(
      `Not an InferOps project board URL: expected inferops://<tenant>.<workspace>/project/board/<KEY>, ` +
      `for example inferops://acme.operations/project/board/ENG, or ` +
      `inferops://${DEMO_HOST}/project/board/DEMO for demo data.`);
  }
  return { host, ...labels, projectKey };
}

/** The canonical URL of a project board. Inverse of `parseProjectBoardUrl`. */
export function projectBoardUrl({ host, projectKey }: Pick<ProjectBoardRef, "host" | "projectKey">): string {
  return `inferops://${host}/project/board/${projectKey}`;
}
