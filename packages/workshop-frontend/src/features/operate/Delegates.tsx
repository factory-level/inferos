import { useEffect, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import type { DelegateSummary } from '@gadgets/workshop-shared/delegate'
import type { SessionWorkspace } from './useSessionWorkspace'

/** Why a delegate ended `failed`, in words (FAC-134 capability 3); an unknown reason says only that. */
const REASONS: Record<string, string> = {
  cancelled: 'you stopped it',
  'requester-revoked': 'your access here changed while it ran',
  'runtime-error': 'it stopped with an error',
}

const stateWords = (delegate: DelegateSummary): string =>
  delegate.state === 'running' ? 'Running'
    : delegate.state === 'succeeded' ? 'Finished'
    : `Failed${delegate.reason && REASONS[delegate.reason] ? `: ${REASONS[delegate.reason]}` : ''}`

/** One delegate: what it may use, how it ended, and, while it runs, a way to stop it. */
const DelegateItem = ({ delegate, onStop }: { delegate: DelegateSummary; onStop: (id: string) => Promise<void> }) => {
  const [stopping, setStopping] = useState<'idle' | 'stopping' | 'failed'>('idle')
  const stop = async () => {
    setStopping('stopping')
    try {
      await onStop(delegate.delegateId)
      setStopping('idle')
    } catch (caught) {
      console.error('Failed to stop a delegate:', caught)
      setStopping('failed')
    }
  }
  return <li className="space-y-1 rounded-lg border border-kumo-line bg-kumo-base p-3 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <p className="m-0 min-w-0 flex-1">
        <span className="font-medium">{delegate.title}</span>
        <span className="text-kumo-subtle"> · {stateWords(delegate)} · launched {new Date(delegate.launchedAt).toLocaleString()}</span>
      </p>
      {delegate.state === 'running' &&
        <Button size="sm" disabled={stopping === 'stopping'} onClick={() => void stop()}>Stop</Button>}
    </div>
    <p className="m-0 text-kumo-subtle">
      Connections: {delegate.connections.length > 0 ? delegate.connections.join(', ') : 'none'} · Tools: {delegate.tools.join(', ')}
    </p>
    {stopping === 'failed' && <p role="alert" className="m-0 text-kumo-danger">Couldn't stop it. Try again.</p>}
  </li>
}

/**
 * The person's own delegates in this operate session (FAC-134 capability 3, ADR 0020), each launched
 * by their own approval of a Dot proposal, with at most their access here. It shows what each may
 * use and how it ended, never what it said, and lets them stop one that is running. Nothing here
 * launches one. Shows nothing while loading or when there are none.
 */
export const Delegates = ({ workspace }: { workspace: SessionWorkspace | null }) => {
  const [attempt, setAttempt] = useState(0)
  const [shown, setShown] = useState<{ stub: SessionWorkspace['stub']; attempt: number;
    delegates: DelegateSummary[] | null }>()
  const stub = workspace?.stub
  useEffect(() => {
    if (!stub) return
    let cancelled = false
    stub.listDelegates().then(
      delegates => { if (!cancelled) setShown({ stub, attempt, delegates }) },
      caught => {
        console.error('Failed to list delegates:', caught)
        if (!cancelled) setShown({ stub, attempt, delegates: null })
      })
    return () => { cancelled = true }
  }, [stub, attempt])
  // Only the answer for this workspace and attempt is shown: a new one never shows the last.
  const current = shown && shown.stub === stub && shown.attempt === attempt ? shown : undefined
  if (!workspace || !current) return null
  if (current.delegates === null) {
    return <section aria-label="Delegates" className="shrink-0 px-5 pb-3">
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
        <p className="m-0 text-kumo-danger">Couldn't load your delegates.</p>
        <Button size="sm" onClick={() => setAttempt(n => n + 1)}>Try again</Button>
      </div>
    </section>
  }
  if (current.delegates.length === 0) return null
  const stop = async (delegateId: string) => {
    await workspace.stub.stopDelegate(delegateId)
    setAttempt(n => n + 1)
  }
  return <section aria-label="Delegates" className="shrink-0 space-y-2 px-5 pb-3">
    <div className="flex items-center gap-2">
      <h2 className="m-0 flex-1 text-sm font-medium">Your delegates</h2>
      <Button size="sm" variant="ghost" onClick={() => setAttempt(n => n + 1)}>Refresh</Button>
    </div>
    <ul className="m-0 space-y-2 p-0">
      {current.delegates.map(delegate => <DelegateItem key={delegate.delegateId} delegate={delegate} onStop={stop} />)}
    </ul>
  </section>
}
