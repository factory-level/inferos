// A Wiki search snippet (InferOpsWikiSession.searchWiki) as text to show. InferOps marks matched
// words with `<b>…</b>` (the contract's highlight sentinels are not built yet), the snippet is the
// section's markdown source, and its cut can fall inside a highlight. So only those two markers are
// read, and everything else (other tags, a lone `</b>`, `&lt;`) stays the characters it is: it is
// rendered as React text, never as HTML.

/** One run of a snippet: literal text, highlighted when InferOps marked it as matching. */
export type SnippetPart = { text: string; highlight: boolean }

/**
 * The snippet split into runs at its `<b>` and `</b>` markers. An opening marker the cut left
 * unclosed highlights to the end; a closing marker with no opening one is dropped.
 */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  let highlight = false
  for (const piece of snippet.split(/(<\/?b>)/)) {
    if (piece === '<b>') highlight = true
    else if (piece === '</b>') highlight = false
    else if (piece) parts.push({ text: piece, highlight })
  }
  return parts
}
