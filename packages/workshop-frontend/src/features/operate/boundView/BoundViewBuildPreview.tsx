import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { BOUND_VIEW_FILE, formatBoundViewProblems, parseBoundViewSpec } from '@gadgets/workshop-shared/bound-view'
import { contain } from './contain'
import { Budget, evaluateBoundView, type BoundViewEvaluation } from './evaluate'
import { BOUND_VIEW_FIXTURE } from './fixture'
import { mountBoundRoot, type BoundRoot } from './BoundViewRenderer'

/**
 * The `view.json` of a gadget's commit, or null while unknown, when it has none, or when it could
 * not be read. Read as committed (the head the editor shows), not from a chat's unsaved changes.
 */
export const useBoundViewSource = (overseer: RpcStub<Overseer> | null, commitId: string | undefined): string | null => {
  const [found, setFound] = useState<{ commitId: string; text: string | null } | null>(null)
  useEffect(() => {
    if (!overseer || !commitId) return
    let cancelled = false
    overseer.readFilesAtCommit(commitId, [BOUND_VIEW_FILE])
      .then(entries => {
        const file = entries.find(([path]) => path === BOUND_VIEW_FILE)?.[1]
        if (!cancelled) setFound({ commitId, text: file?.kind === 'text' ? file.text : null })
      }, () => { if (!cancelled) setFound({ commitId, text: null }) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [overseer, commitId])
  return found && found.commitId === commitId ? found.text : null
}

type PreviewResult = { status: 'problems'; problems: string } | (BoundViewEvaluation & { title: string }) | { status: 'failed' }

/**
 * The Build preview of a view-only widget: its `view.json` checked live with the v1 parser (problem
 * codes and spec paths, never values), and rendered by the real renderer in its own dedicated root
 * over a synthetic, labelled fixture board for every requirement. No InferOps data is read here.
 */
export const BoundViewBuildPreview = ({ text }: { text: string }) => {
  const [failed, setFailed] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<BoundRoot | null>(null)
  // Parsed and evaluated once per text: the dedicated root re-renders only when the spec changes.
  // Contained like the Operate view's evaluation: a throw becomes the fixed failed state, unread.
  const result = useMemo(() => {
    let outcome: PreviewResult = { status: 'failed' }
    contain(() => { outcome = { status: 'failed' } }, () => {
      const parsed = parseBoundViewSpec(text)
      if (!parsed.ok) { outcome = { status: 'problems', problems: formatBoundViewProblems(parsed.problems) }; return }
      const evaluation = evaluateBoundView(parsed.spec, new Map(parsed.spec.requirements.map(name => [name, BOUND_VIEW_FIXTURE])), new Budget())
      outcome = { ...evaluation, title: parsed.spec.title }
    })()
    // Assigned inside the contained callback, which control-flow narrowing cannot see.
    return outcome as PreviewResult
  }, [text])
  const tree = result.status === 'ok' ? result.tree : null

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    let root: BoundRoot | null = null
    contain(() => setFailed(true), () => { root = mountBoundRoot(container, () => setFailed(true)) })()
    rootRef.current = root
    return () => {
      rootRef.current = null
      container.style.display = 'none'
      // Never during React's commit: the dedicated root is unmounted in a microtask.
      if (root) { const mounted: BoundRoot = root; queueMicrotask(() => { try { mounted.unmount() } catch { /* dropped */ } }) }
    }
  }, [])
  useLayoutEffect(() => contain(() => setFailed(true), () => {
    const container = containerRef.current
    if (container) container.style.display = tree && !failed ? '' : 'none'
    if (tree && !failed) rootRef.current?.render(tree)
  })(), [tree, failed])

  return <section aria-label="View preview" className="h-full space-y-4 overflow-auto p-5 text-sm">
    <header className="space-y-1">
      <h2 className="text-base font-medium text-kumo-default">{'title' in result ? <bdi>{result.title}</bdi> : 'view.json'}</h2>
      <p role="note" className="text-xs text-kumo-subtle">Preview over a made-up sample board, not your InferOps data. Operators see it over their own boards once the view is registered on a console and published.</p>
    </header>
    {result.status === 'problems' && <div role="alert" className="space-y-1 text-kumo-danger">
      <p>This view.json can&apos;t be used yet:</p>
      <p><code>{result.problems}</code></p>
    </div>}
    {result.status === 'too-large' && <p role="status" className="text-kumo-subtle">This view is too large to show.</p>}
    {result.status === 'invalid' && <p role="status" className="text-kumo-subtle">This view can&apos;t be shown over the sample board.</p>}
    {(failed || result.status === 'failed') && <p role="status" className="text-kumo-subtle">This preview could not be shown. Edit view.json, or reload to try again.</p>}
    {/* The dedicated root's container: no class, display set inline only. */}
    <div ref={containerRef} />
  </section>
}
