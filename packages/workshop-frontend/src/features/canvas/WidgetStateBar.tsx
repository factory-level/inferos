import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { OperateSession } from '@gadgets/workshop-shared/api'
import {
  WIDGET_STATE_ERROR_CODES, type OperateWidgetRef, type WidgetStateSnapshot,
} from '@gadgets/workshop-shared/widget-state'
import { WorkshopButton } from '../../components/WorkshopControls'

type Loaded =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snapshot: WidgetStateSnapshot }

/** A refusal's code (`WIDGET_…`) and its words, as the server sent them. */
const refusalOf = (err: unknown) => {
  const text = err instanceof Error ? err.message : String(err)
  const match = /(WIDGET_[A-Z_]+): (.*)$/s.exec(text)
  return match ? { code: match[1]!, message: match[2]! } : { code: null, message: text || 'Something went wrong.' }
}

/**
 * A console widget's own local state in Operate (FAC-86): the state it is in and only the events
 * its published declaration accepts from there. Moving it changes the widget alone, never the
 * page. A refused event shows the server's words; a conflict (the state moved elsewhere) reloads
 * the latest state rather than overwriting it. A widget that declares no states shows nothing.
 * `onStateChange` hears the state it shows (null while none is known), so the widget can be told.
 * `onPrompt` hears the draft a transition's event is wired to put in the person's chat (FAC-98,
 * `snapshot.prompt`): the page puts it in the composer, and nothing is sent for them.
 */
export const WidgetStateBar = ({ session, widgetRef, onStateChange, onPrompt }: {
  session: RpcStub<OperateSession>
  widgetRef: OperateWidgetRef
  onStateChange?: (state: string | null) => void
  onPrompt?: (text: string) => void
}) => {
  const [loaded, setLoadedState] = useState<Loaded>({ status: 'loading' })
  const onStateChangeRef = useRef(onStateChange)
  onStateChangeRef.current = onStateChange
  const onPromptRef = useRef(onPrompt)
  onPromptRef.current = onPrompt
  const setLoaded = (next: Loaded) => {
    setLoadedState(next)
    onStateChangeRef.current?.(next.status === 'ready' ? next.snapshot.state : null)
  }
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'refused' | 'reloaded'; message: string } | null>(null)
  const { workspaceId, consoleId, revision, gadgetId } = widgetRef

  const read = async () => {
    try {
      const snapshot = await session.getWidgetState({ workspaceId, consoleId, revision, gadgetId })
      setLoaded({ status: 'ready', snapshot })
    } catch (err) {
      const { code, message } = refusalOf(err)
      setLoaded(code === WIDGET_STATE_ERROR_CODES.noStates ? { status: 'none' } : { status: 'error', message })
    }
  }

  useEffect(() => {
    setLoaded({ status: 'loading' })
    setNotice(null)
    void read()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the ref's fields are the identity
  }, [session, workspaceId, consoleId, revision, gadgetId])

  const send = async (event: string, expectedSeq: number) => {
    setBusy(true)
    setNotice(null)
    try {
      const snapshot = await session.transitionWidget({ workspaceId, consoleId, revision, gadgetId }, event, expectedSeq)
      setLoaded({ status: 'ready', snapshot })
      if (snapshot.prompt) onPromptRef.current?.(snapshot.prompt.text)
    } catch (err) {
      const { code, message } = refusalOf(err)
      if (code === WIDGET_STATE_ERROR_CODES.conflict) {
        // Another tab or session moved it first: show where it is now, never write over it.
        await read()
        setNotice({ kind: 'reloaded', message: `${message} It now shows the latest state.` })
      } else {
        setNotice({ kind: 'refused', message })
      }
    } finally {
      setBusy(false)
    }
  }

  if (loaded.status === 'none' || loaded.status === 'loading') return null
  if (loaded.status === 'error') {
    return <p role="alert" className="border-b border-kumo-line px-3 py-2 text-[12px] text-kumo-danger">{loaded.message}</p>
  }
  const { snapshot } = loaded
  return (
    <section aria-label="Widget state" className="flex flex-wrap items-center gap-2 border-b border-kumo-line px-3 py-2">
      <span className="text-[12px] leading-4 text-kumo-subtle">
        State: <span className="font-medium text-kumo-default">{snapshot.state}</span>
      </span>
      {snapshot.events.map(event => (
        <WorkshopButton key={event} disabled={busy} onClick={() => send(event, snapshot.seq)}>{event}</WorkshopButton>
      ))}
      {notice && (
        <span role={notice.kind === 'refused' ? 'alert' : 'status'}
          className={`text-[12px] leading-4 ${notice.kind === 'refused' ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>
          {notice.message}
        </span>
      )}
    </section>
  )
}
