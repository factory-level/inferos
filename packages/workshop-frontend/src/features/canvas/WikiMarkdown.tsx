import type { ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from '@cloudflare/kumo'
import { safeExternalUrl } from '../../utils/safeExternalUrl'
import { wikiPageSlug } from './wikiPage'

// Raw HTML in a section is never rendered (`skipHtml`). URLs go through react-markdown's own
// sanitizer, which empties `javascript:`, `data:` and other unsafe schemes; only `inferops://` is let
// through it, and only so the reference can be shown as a title. Only http(s) links become anchors:
// an `inferops://` link inside prose is a mention, not an embed, and shows as its text. Images are
// not fetched: a page could otherwise make every viewer's browser request an arbitrary URL. A Wiki
// route (`/wiki/<slug>`, as a Master's generated block links its pages) selects that page in the
// widget, a button rather than a navigation away from the canvas.
const ExternalLink = ({ href, children }: { href?: string; children?: ReactNode }) => {
  const safe = safeExternalUrl(href)
  return safe
    ? <a href={safe} target="_blank" rel="noopener noreferrer" className="text-kumo-brand underline">{children}</a>
    : <span title={href || undefined}>{children}</span>
}

const COMPONENTS: Components = {
  img: ({ alt }) => <span>{alt ? `[${alt}]` : '[image]'}</span>,
}

const urlTransform = (url: string) => url.startsWith('inferops://') ? url : defaultUrlTransform(url)

/** Wiki Markdown with GitHub-flavoured extensions, styled with structure and typography utilities only. */
export const WikiMarkdown = ({ text, onOpenPage }: {
  text: string
  /** Open the page a `/wiki/<slug>` link names. */
  onOpenPage: (slug: string) => void
}) => {
  const components: Components = {
    ...COMPONENTS,
    a: ({ href, children }) => {
      const slug = wikiPageSlug(href)
      return slug === null ? <ExternalLink href={href}>{children}</ExternalLink>
        : <Link render={<button type="button" />} onClick={() => onOpenPage(slug)}>{children}</Link>
    },
  }
  return <div className="space-y-2 text-sm leading-relaxed text-kumo-default [overflow-wrap:anywhere] [&_blockquote]:border-l-2 [&_blockquote]:border-kumo-line [&_blockquote]:pl-3 [&_blockquote]:text-kumo-subtle [&_code]:font-mono [&_code]:text-xs [&_h1]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-kumo-line [&_pre]:bg-kumo-elevated [&_pre]:p-2 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-kumo-line [&_td]:px-2 [&_th]:border [&_th]:border-kumo-line [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5">
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={urlTransform} components={components}>{text}</ReactMarkdown>
  </div>
}
