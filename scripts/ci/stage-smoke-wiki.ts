// The pure half of node 10's wiki oracles (`operator.wikiReads`, `viewer.wikiReads` in
// stage-smoke-flow.ts): which text a Wiki page must show on the canvas, and whether the page the
// gatekeeper read is the page InferOps' own API answers. No I/O, so `ci.test.ts` covers it.

/** The grokbot tenant's InferMind Wiki, read when `FACTORY_STAGE_WIKI` names no other. */
export const DEFAULT_WIKI = "inferops://grokbot.knowledge/knowledge/wiki";

/** A Wiki page as either side reads it: the fields the oracle compares. */
export interface WikiPageText {
  slug: string;
  title: string;
  /** The page's authored Markdown; empty when it has none. */
  body: string;
  /** Section bodies in page order; shown only when the page has no body. */
  sections: readonly string[];
}

const MAX_PHRASE = 120;
const MAX_PHRASES = 3;

/** One Markdown line as the rendered page shows its text, or null for a line with no prose. */
function prose(line: string): string | null {
  const trimmed = line.trim();
  // Tables, rules and HTML render as something other than their source text.
  if (!trimmed || /^(\||<|---+$|\*\*\*+$)/.test(trimmed)) return null;
  const text = trimmed
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, target: string, label?: string) => label ?? target)
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

/** A phrase cut at a word boundary, so a long line still matches however it wraps. */
function cut(phrase: string): string {
  if (phrase.length <= MAX_PHRASE) return phrase;
  const head = phrase.slice(0, MAX_PHRASE);
  const space = head.lastIndexOf(" ");
  return space > 20 ? head.slice(0, space) : head;
}

/**
 * The text the canvas must show for `page`: its title, then the first prose lines of what the
 * widget renders (the body, or for a page without one its sections), whitespace-collapsed.
 */
export function wikiExpectedText(page: WikiPageText): string[] {
  const source = page.body.trim() ? [page.body] : page.sections;
  const lines: string[] = [];
  for (const markdown of source) {
    let fenced = false;
    for (const line of markdown.split("\n")) {
      // A fenced block's lines are code, not prose, whatever they say.
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
      const text = fenced ? null : prose(line);
      if (text !== null) lines.push(text);
    }
  }
  return [...new Set([page.title.replace(/\s+/g, " ").trim(), ...lines.slice(0, MAX_PHRASES).map(cut)])].filter(Boolean);
}

/** The expected phrases `rendered` (a page's innerText) does not contain, comparing collapsed whitespace. */
export function missingWikiText(rendered: string, expected: readonly string[]): string[] {
  const text = rendered.replace(/\s+/g, " ");
  return expected.filter(phrase => !text.includes(phrase));
}

/** Why the gatekeeper's read of a page differs from InferOps' own, or null when they agree. */
export function wikiDisagreement(gatekeeper: WikiPageText, inferops: WikiPageText): string | null {
  if (gatekeeper.slug !== inferops.slug) return `slug ${gatekeeper.slug} vs ${inferops.slug}`;
  if (gatekeeper.title !== inferops.title) return "the title differs";
  if (gatekeeper.body !== inferops.body) return "the body differs";
  if (gatekeeper.sections.length !== inferops.sections.length) return `${gatekeeper.sections.length} sections vs ${inferops.sections.length}`;
  const at = gatekeeper.sections.findIndex((body, index) => body !== inferops.sections[index]);
  return at >= 0 ? `section ${at + 1} differs` : null;
}
