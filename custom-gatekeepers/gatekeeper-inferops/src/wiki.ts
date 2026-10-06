// The Wiki's read projections, ported from InferOps so InferOS reads a page the way InferOps does
// (pure: no request, no storage).
//
// - Wikilinks: InferOps' v1 `[[target#tag]]` grammar (`domains/knowledge/shared/wikilinks.ts`),
//   deduplicated on (target, tag), first occurrence wins.
// - Embedded references: InferOps' block-embed rule (`_libs/widgets/shared/resolve.ts`): a
//   paragraph, split on blank lines, that is solely `[label](inferops://…)` is an embed; a link
//   inside prose is not. The href must parse as InferOps' `parseInferopsUri` would accept it.
// - Page text: InferOps' one page-text contract (`domains/knowledge/shared/document-text.ts`,
//   mirrored exactly by `composeDocumentText` and `masterStructureText`): `# <title>`, then the
//   page's body without a leading `# <title>` line, or the visible section bodies when it has no body,
//   then a Master's generated structure block. InferOps' `renderDocumentAsText` then replaces each
//   embed with its live state; InferOS leaves the link as written and never resolves another
//   resource's data here.
// - Access boundary (InferOps' rule, kept here): the body is document-level (anyone with the
//   workspace and `knowledge:read`), sections are lens-gated, and a page with a body reads as its
//   body. Nothing here copies section text into a body, and a page with nothing to read composes
//   to null, so a bare title never passes the lens.

import type { WikiLink, WikiStructure } from "./types";

const WIKILINK = /\[\[([^[\]#|]+)#([^[\]#|]+)\]\]/g;
const EMBED_ONLY_PARAGRAPH = /^\[[^\]]*\]\((inferops:\/\/[^\s)]+)\)$/;
const PARAGRAPH_SPLIT = /\r?\n[ \t]*\r?\n/;

/** The body's `[[target#tag]]` links, each (target, tag) once, in order of first appearance. */
export function wikilinksOf(body: string): WikiLink[] {
  const seen = new Set<string>();
  const links: WikiLink[] = [];
  for (const match of body.matchAll(new RegExp(WIKILINK.source, "g"))) {
    const target = match[1]?.trim();
    const tag = match[2]?.trim();
    if (!target || !tag) continue;
    const key = `${target}#${tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ target, tag });
  }
  return links;
}

/**
 * Whether InferOps would parse `href` as an `inferops://` reference: a `<tenant>.<workspace>` host
 * of exactly two non-empty labels and at least a domain and a widget in the path.
 */
function isInferOpsReference(href: string): boolean {
  try {
    const url = new URL(href);
    if (url.protocol !== "inferops:") return false;
    const labels = url.hostname.split(".");
    if (labels.length !== 2 || !labels[0] || !labels[1]) return false;
    return url.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

/** The `inferops://` references embedded in `bodies` as standalone paragraphs, each once, in order. */
export function embeddedReferences(bodies: readonly string[]): string[] {
  const references = new Set<string>();
  for (const body of bodies) {
    for (const paragraph of body.split(PARAGRAPH_SPLIT)) {
      const href = EMBED_ONLY_PARAGRAPH.exec(paragraph.trim())?.[1];
      if (href !== undefined && isInferOpsReference(href)) references.add(href);
    }
  }
  return [...references];
}

/**
 * A page that has no body and is not a Master, as agent text: `# <title>`, then each section's
 * body, separated by blank lines. `composeDocumentText` is the whole contract.
 */
export function documentText(title: string, bodies: readonly string[]): string {
  return [`# ${title}`, ...bodies].join("\n\n");
}

/** A leading level-one heading line, captured. */
const LEADING_H1 = /^\s*#\s+(.*?)\s*(?:\r?\n|$)/;

/**
 * The page body without a leading heading that repeats the page title (the text adds the title
 * once). Any other leading heading is authored content and is kept.
 */
export function bodyWithoutTitle(body: string, title: string): string {
  const match = LEADING_H1.exec(body);
  return match && match[1]?.trim() === title.trim() ? body.slice(match[0].length) : body;
}

/** A page's Wiki route: the slug is one encoded segment, so `dispatch/dispatch-a-crew` stays one page. */
export function wikiPagePath(slug: string): string {
  return `/wiki/${encodeURIComponent(slug)}`;
}

/** One line of a generated block: a link to the page's Wiki route. */
function pageLink(target: { slug: string; title: string }): string {
  return `- [${target.title}](${wikiPagePath(target.slug)})`;
}

/**
 * A root or pillar Master's generated structure block: the pillars the root organizes, or the pages
 * a pillar files; null for any other page, and for a pillar Master no pillar names.
 */
export function masterStructureText(
  page: { id: string; masterRole: "root" | "pillar" | null }, structure: WikiStructure,
): string | null {
  if (page.masterRole === "root") {
    const lines = structure.pillars.map(p => p.master ? pageLink({ slug: p.master.slug, title: p.title }) : `- ${p.title}`);
    return ["<!-- generated: wiki structure -->", "## Pillars", ...(lines.length ? lines : ["(none yet)"])]
      .join("\n");
  }
  if (page.masterRole === "pillar") {
    const pillar = structure.pillars.find(p => p.master?.id === page.id);
    if (!pillar) return null;
    const lines = pillar.members.map(pageLink);
    return ["<!-- generated: wiki structure -->", `## Pages in ${pillar.title}`,
            ...(lines.length ? lines : ["(none yet)"])].join("\n");
  }
  return null;
}

/** What a page reads as: its body, the section bodies the reader sees, and its generated block. */
export type PageContent = { body: string; visibleSections: readonly string[]; generated: string | null };

/** The authored content a page reads as: its body when it has one, else its visible sections. */
export function authoredContent(title: string, { body, visibleSections }: Omit<PageContent, "generated">):
    string[] {
  return body.trim() ? [bodyWithoutTitle(body, title).trim()] : [...visibleSections];
}

/**
 * A page as text: `# <title>`, a blank line, then its authored content and generated block joined
 * by blank lines; null when there is nothing to read.
 */
export function composeDocumentText(title: string, content: PageContent): string | null {
  const parts = [...authoredContent(title, content), ...(content.generated ? [content.generated] : [])]
    .filter(part => part.trim());
  return parts.length ? `# ${title}\n\n${parts.join("\n\n")}` : null;
}
