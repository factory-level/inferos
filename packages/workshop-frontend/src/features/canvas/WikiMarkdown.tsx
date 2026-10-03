import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { safeExternalUrl } from '../../utils/safeExternalUrl'

// Raw HTML in a section is never rendered (`skipHtml`). URLs go through react-markdown's own
// sanitizer, which empties `javascript:`, `data:` and other unsafe schemes; only `inferops://` is let
// through it, and only so the reference can be shown as a title. Only http(s) links become anchors:
// an `inferops://` link inside prose is a mention, not an embed, and shows as its text. Images are
// not fetched: a page could otherwise make every viewer's browser request an arbitrary URL.
const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const safe = safeExternalUrl(href)
    return safe
      ? <a href={safe} target="_blank" rel="noopener noreferrer" className="text-kumo-brand underline">{children}</a>
      : <span title={href || undefined}>{children}</span>
  },
  img: ({ alt }) => <span>{alt ? `[${alt}]` : '[image]'}</span>,
}

const urlTransform = (url: string) => url.startsWith('inferops://') ? url : defaultUrlTransform(url)

/** Section Markdown with GitHub-flavoured extensions, styled with structure and typography utilities only. */
export const WikiMarkdown = ({ text }: { text: string }) =>
  <div className="space-y-2 text-sm leading-relaxed text-kumo-default [overflow-wrap:anywhere] [&_blockquote]:border-l-2 [&_blockquote]:border-kumo-line [&_blockquote]:pl-3 [&_blockquote]:text-kumo-subtle [&_code]:font-mono [&_code]:text-xs [&_h1]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-kumo-line [&_pre]:bg-kumo-elevated [&_pre]:p-2 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-kumo-line [&_td]:px-2 [&_th]:border [&_th]:border-kumo-line [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5">
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={urlTransform} components={COMPONENTS}>{text}</ReactMarkdown>
  </div>
