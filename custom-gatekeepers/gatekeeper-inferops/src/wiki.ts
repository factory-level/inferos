// The Wiki's read projections, ported from InferOps so InferOS reads a page the way InferOps does
// (pure: no request, no storage).
//
// - Wikilinks: InferOps' v1 `[[target#tag]]` grammar (`domains/knowledge/shared/wikilinks.ts`),
//   deduplicated on (target, tag), first occurrence wins.
// - Embedded references: InferOps' block-embed rule (`_libs/widgets/shared/resolve.ts`): a
//   paragraph, split on blank lines, that is solely `[label](inferops://…)` is an embed; a link
//   inside prose is not. The href must parse as InferOps' `parseInferopsUri` would accept it.
// - Agent text: `renderDocumentAsText` (`domains/knowledge/backend/render.ts`), the title and the
//   section bodies joined by blank lines. InferOps then replaces each embed with its live state;
//   InferOS leaves the link as written and never resolves another resource's data here.

import type { WikiLink } from "./types";

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

/** A page as agent text: `# <title>`, then each section's body, separated by blank lines. */
export function documentText(title: string, bodies: readonly string[]): string {
  return [`# ${title}`, ...bodies].join("\n\n");
}
