// The resource-URL grammar, InferOps' own (`_libs/widgets/shared/inferops-uri.ts`):
// `inferops://<tenant>.<workspace>/project/<kind>/<KEY>`, where `<kind>` is `board` (read the board,
// propose issue changes) or `dispatch` (hand the project's software issues to the coding runner).
// The two kinds are separate grants: a board binding can never dispatch. A third kind,
// `inferops://<tenant>.<workspace>/knowledge/wiki`, grants one person's read of the workspace's
// InferMind Wiki and proposed section edits; `…/knowledge/document/<slug>` names one page of it and
// is a reference only, never bound. A URL names a target; it never grants
// anything by itself, and it never names a deployment: the API base URL and the credentials come
// from the account and the deployment's configuration. The gatekeeper resolves the workspace slug
// against the person's own workspaces, binds the result into its props when the Workshop mints the
// capability, and every later call reads scope from those props only. The tenant label is checked
// for syntax and kept in the URL, but authorizes nothing (see `parseProjectBoardUrl`).

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

/** The host of the built-in demo data, and the only one the mock serves. Never an InferOps tenant. */
export const DEMO_HOST = "demo.local";

/** One project board: read it and propose issue creates, updates and moves. */
export const PROJECT_BOARD_RESOURCE: SupportedResource = {
  urlPattern: "inferops://*/project/board/*",
  title: "InferOps project board",
  description:
    "Read one InferOps project's board and propose moving its issues between workflow states.",
};

/**
 * Coding dispatch for one project: propose handing its software issues to the local coding runner,
 * and follow and cancel the runs. A grant of its own, offered only while the deployment has
 * `CODING_WORKBENCH_ENABLED` on; a board grant never carries it.
 */
export const PROJECT_DISPATCH_RESOURCE: SupportedResource = {
  urlPattern: "inferops://*/project/dispatch/*",
  title: "InferOps coding dispatch",
  description:
    "Propose handing one InferOps project's software issues to the local coding runner, and " +
    "follow or cancel its runs.",
};

/**
 * One workspace's InferMind Wiki: read its pages and propose section edits. Pages in it are named
 * by `inferops://<tenant>.<workspace>/knowledge/document/<slug>` references, which grant nothing.
 */
export const KNOWLEDGE_WIKI_RESOURCE: SupportedResource = {
  urlPattern: "inferops://*/knowledge/wiki",
  title: "InferMind Wiki",
  description:
    "Read the pages of one InferMind workspace's Wiki and propose edits to their sections.",
  // The Wiki is not chat context in an operate session (#61); its own surfaces are separate.
  excludeFromOperateChat: true,
};

/** The project-scoped resource kinds, by the path segment that names them. */
export type ProjectResourceKind = "board" | "dispatch";

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

const KIND_NOUN: Record<ProjectResourceKind, string> = {
  board: "project board",
  dispatch: "coding dispatch",
};

/**
 * Parse a project resource URL of `kind`, or throw a message naming the expected form. Only syntax
 * is checked: exactly two lowercase slug labels, no port, no user info. Whether the workspace is the
 * caller's is decided by the account; the tenant label is never trusted for anything.
 */
function parseProjectUrl(url: string, kind: ProjectResourceKind): ProjectBoardRef {
  const match = /^inferops:\/\/([^/?#]+)\/project\/([a-z]+)\/([^/?#]+)\/?$/.exec(url.trim());
  const host = match?.[1];
  const projectKey = match?.[3];
  const labels = host ? parseHost(host) : null;
  if (match?.[2] !== kind || !host || !labels || !projectKey || !PROJECT_KEY.test(projectKey)) {
    throw new Error(
      `Not an InferOps ${KIND_NOUN[kind]} URL: expected ` +
      `inferops://<tenant>.<workspace>/project/${kind}/<KEY>, ` +
      `for example inferops://acme.operations/project/${kind}/ENG, or ` +
      `inferops://${DEMO_HOST}/project/${kind}/DEMO for demo data.`);
  }
  return { host, ...labels, projectKey };
}

/** Parse a project-board URL, or throw a message naming the expected form. */
export function parseProjectBoardUrl(url: string): ProjectBoardRef {
  return parseProjectUrl(url, "board");
}

/** Parse a coding-dispatch URL, or throw a message naming the expected form. */
export function parseProjectDispatchUrl(url: string): ProjectBoardRef {
  return parseProjectUrl(url, "dispatch");
}

/** The kind a project resource URL names, or null when it names neither (the parsers explain why). */
export function projectResourceKind(url: string): ProjectResourceKind | null {
  const kind = /^inferops:\/\/[^/?#]+\/project\/([a-z]+)\//.exec(url.trim())?.[1];
  return kind === "board" || kind === "dispatch" ? kind : null;
}

/** Every resource kind, by what its URL's path names. */
export type ResourceKind = ProjectResourceKind | "wiki";

/** The kind a resource URL names, or null when it names none (the parsers explain why). */
export function resourceKind(url: string): ResourceKind | null {
  if (/^inferops:\/\/[^/?#]+\/knowledge\/wiki\/?$/.test(url.trim())) return "wiki";
  return projectResourceKind(url);
}

/** A parsed Wiki resource URL: the workspace's `<tenant>.<workspace>` host and its labels. */
export type WikiRef = { host: string; tenant: string; workspace: string };

/** Parse a Wiki resource URL, or throw a message naming the expected form. Syntax only. */
export function parseWikiUrl(url: string): WikiRef {
  const host = /^inferops:\/\/([^/?#]+)\/knowledge\/wiki\/?$/.exec(url.trim())?.[1];
  const labels = host ? parseHost(host) : null;
  if (!host || !labels) {
    throw new Error(
      "Not an InferMind Wiki URL: expected inferops://<tenant>.<workspace>/knowledge/wiki, for " +
      `example inferops://acme.knowledge/knowledge/wiki, or inferops://${DEMO_HOST}/knowledge/wiki ` +
      "for demo data.");
  }
  return { host, ...labels };
}

/** The canonical URL of a workspace's Wiki. Inverse of `parseWikiUrl`. */
export function wikiUrl({ host }: Pick<WikiRef, "host">): string {
  return `inferops://${host}/knowledge/wiki`;
}

/** A parsed Wiki page reference: the workspace and the page's slug. */
export type WikiDocumentRef = WikiRef & { slug: string };

// A document slug as it can appear in a reference: URL-unreserved characters only, so it needs no
// escaping and cannot smuggle a path, query or fragment. InferOps' own slugs are lowercase words
// joined by hyphens.
const DOCUMENT_SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/;

/** Whether `value` can be a Wiki page slug in a reference. */
export function isDocumentSlug(value: string): boolean {
  return DOCUMENT_SLUG.test(value);
}

/**
 * Parse a Wiki page reference, `inferops://<tenant>.<workspace>/knowledge/document/<slug>`, or
 * return null when `url` is not one. It identifies a page and grants nothing: the page is
 * readable only through a Wiki binding of the same workspace.
 */
export function parseWikiDocumentUrl(url: string): WikiDocumentRef | null {
  const match = /^inferops:\/\/([^/?#]+)\/knowledge\/document\/([^/?#]+)\/?$/.exec(url.trim());
  const labels = match ? parseHost(match[1]!) : null;
  if (!match || !labels || !isDocumentSlug(match[2]!)) return null;
  return { host: match[1]!, ...labels, slug: match[2]! };
}

/** The reference of one Wiki page. Inverse of `parseWikiDocumentUrl`. */
export function wikiDocumentUrl({ host, slug }: Pick<WikiDocumentRef, "host" | "slug">): string {
  return `inferops://${host}/knowledge/document/${slug}`;
}

/** The canonical URL of a project board. Inverse of `parseProjectBoardUrl`. */
export function projectBoardUrl({ host, projectKey }: Pick<ProjectBoardRef, "host" | "projectKey">): string {
  return `inferops://${host}/project/board/${projectKey}`;
}

/** The canonical URL of a project's coding dispatch. Inverse of `parseProjectDispatchUrl`. */
export function projectDispatchUrl({ host, projectKey }: Pick<ProjectBoardRef, "host" | "projectKey">): string {
  return `inferops://${host}/project/dispatch/${projectKey}`;
}
