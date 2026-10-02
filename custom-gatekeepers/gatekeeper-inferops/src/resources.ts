// The resource-URL grammar: `inferops://<host>/project/board/<KEY>`. A URL names a target; it never
// grants anything by itself. The gatekeeper binds the parsed host and key into its props when the
// Workshop mints the capability, and every later call reads scope from those props only.

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

/** The InferOps host used when none is configured, and the only one the mock serves. */
export const DEFAULT_HOST = "demo.local";

/** One project board, the only grantable resource type. */
export const PROJECT_BOARD_RESOURCE: SupportedResource = {
  urlPattern: "inferops://*/project/board/*",
  title: "InferOps project board",
  description:
    "Read one InferOps project's board and propose moving its issues between workflow states.",
};

/** A parsed project-board resource URL. */
export type ProjectBoardRef = { host: string; projectKey: string };

// Project keys as InferOps issues them: an uppercase letter, then uppercase letters or digits.
const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,15}$/;
// A DNS-style host name with an optional port; enough to refuse anything that is not one.
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;

/** Parse a project-board URL, or throw a message naming the expected form. */
export function parseProjectBoardUrl(url: string): ProjectBoardRef {
  const match = /^inferops:\/\/([^/?#]+)\/project\/board\/([^/?#]+)\/?$/.exec(url.trim());
  const host = match?.[1]?.toLowerCase();
  const projectKey = match?.[2];
  if (!host || !projectKey || !HOST.test(host) || !PROJECT_KEY.test(projectKey)) {
    throw new Error(
      `Not an InferOps project board URL: expected inferops://<host>/project/board/<KEY>, ` +
      `for example inferops://${DEFAULT_HOST}/project/board/DEMO.`);
  }
  return { host, projectKey };
}

/** The canonical URL of a project board. Inverse of `parseProjectBoardUrl`. */
export function projectBoardUrl({ host, projectKey }: ProjectBoardRef): string {
  return `inferops://${host}/project/board/${projectKey}`;
}
