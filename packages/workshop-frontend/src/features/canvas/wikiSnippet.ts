// A Wiki search snippet (InferOpsWikiSession.searchWiki) as text to show. InferOps marks matched
// words with `<b>…</b>` (the contract's highlight sentinels are not built yet), the snippet is the
// section's markdown source, and its cut can fall inside a highlight. So only a paired `<b>` and
// `</b>` is read as a highlight, and everything else (other tags, an unmatched `<b>` or `</b>`,
// `&lt;`) stays the characters it is: it is rendered as React text, never as HTML.

/** One run of a snippet: literal text, highlighted when InferOps marked it as matching. */
export type SnippetPart = { text: string; highlight: boolean }

/**
 * The snippet split into runs: the text between a `<b>` and the next marker, when that marker is a
 * `</b>`, is highlighted. Any other marker, unmatched because the cut fell inside a highlight or
 * because the author wrote it, stays in the text as written. Adjacent literal text is one run.
 */
export function snippetParts(snippet: string): SnippetPart[] {
  const pieces = snippet.split(/(<\/?b>)/)
  const parts: SnippetPart[] = []
  const push = (text: string, highlight: boolean) => {
    if (!text) return
    const last = parts[parts.length - 1]
    if (last && !last.highlight && !highlight) last.text += text
    else parts.push({ text, highlight })
  }
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!
    // A pair is `<b>`, its text, then `</b>`: split puts the markers at odd indexes.
    if (piece === '<b>' && pieces[i + 2] === '</b>') {
      push(pieces[i + 1]!, true)
      i += 2
    } else {
      push(piece, false)
    }
  }
  return parts
}
