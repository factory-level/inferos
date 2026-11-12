import { useEffect, useState, type CSSProperties } from 'react'
import { Badge, Button } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, OperateSession, Overseer } from '@gadgets/workshop-shared/api'
import {
  TEMPORARY_CANVAS_ERROR_CODES, TEMPORARY_CANVAS_EXPIRED, type TemporaryCanvas,
} from '@gadgets/workshop-shared/temporary-canvas'
import { CANVAS_ROW_PX, PlacedWidget } from './PlacedWidget'

/** The code a refused temporary canvas call leads its message with, which survives RPC. */
const codeOf = (error: unknown): string | null =>
  /^(?:\w*Error: )?([A-Z_]+): /.exec(error instanceof Error ? error.message : String(error))?.[1] ?? null

/** What a refusal tells the person, by its code; anything else is an error to retry. */
const REFUSALS: Record<string, string> = {
  [TEMPORARY_CANVAS_ERROR_CODES.expired]: TEMPORARY_CANVAS_EXPIRED,
  [TEMPORARY_CANVAS_ERROR_CODES.conflict]: 'It changed since this page read it. Here it is as it is now.',
  [TEMPORARY_CANVAS_ERROR_CODES.notFound]: 'It is gone: removed, expired, or your company changed.',
}

type ListState =
  | { status: 'loading' }
  | { status: 'error' }
  /** Temporary canvases live only in the person's own live operate session. */
  | { status: 'unavailable' }
  | { status: 'ready'; canvases: TemporaryCanvas[] }

type Shown = { session: RpcStub<OperateSession>; attempt: number; state: ListState }

/** True once an unsaved canvas's server-set expiry has passed at `now`. */
const expiredAt = (canvas: TemporaryCanvas, now: number) =>
  canvas.expiresAt !== undefined && new Date(canvas.expiresAt).getTime() <= now

/**
 * Re-renders when the soonest of `canvases`' expiry times passes, so a canvas the person is looking
 * at reads as expired then, as the server will treat it, without a reload. The time is the server's.
 */
const useNowAtExpiry = (canvases: readonly TemporaryCanvas[]): number => {
  const [now, setNow] = useState(() => Date.now())
  const next = Math.min(...canvases.map(canvas => canvas.expiresAt ? new Date(canvas.expiresAt).getTime() : Infinity)
    .filter(at => at > now))
  useEffect(() => {
    if (!Number.isFinite(next)) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()))
    return () => clearTimeout(timer)
  }, [next])
  return now
}

/** One temporary canvas, open: its placements as the Dot composed them, read with the person's own access. */
const OpenCanvas = ({ canvas, api, viewer, session, sessionWorkspace }: {
  canvas: TemporaryCanvas
  api: RpcStub<AuthenticatedApi>
  viewer: object | null
  session: RpcStub<OperateSession>
  sessionWorkspace: RpcStub<Overseer> | null
}) =>
  <div className="grid grid-cols-1 gap-3 md:grid-cols-12" style={{ gridAutoRows: `minmax(${CANVAS_ROW_PX}px, auto)` }}
    aria-label={`${canvas.title} canvas`} role="region">
    {canvas.placements.map(placement => (
      <div key={placement.placementId} className="flex min-w-0 md:[grid-column:var(--col)] md:[grid-row:var(--row)]"
        style={{
          '--col': `${placement.layout.x + 1} / span ${placement.layout.w}`,
          '--row': `${placement.layout.y + 1} / span ${placement.layout.h}`,
        } as CSSProperties}>
        <PlacedWidget placement={placement} api={api} viewer={viewer} session={session}
          sessionWorkspace={sessionWorkspace} focused={false} />
      </div>
    ))}
  </div>

/**
 * The person's temporary canvases (FAC-137): each composed by their own Dot and created by their own
 * approval, in their own operate session for the company they work in now. An unsaved one says it is
 * temporary and when it expires, as the server set it; at that time it reads as expired and can no
 * longer be opened or saved. Saving it (it then no longer expires) and removing it are the person's
 * own actions here; neither changes anything it shows, and nothing here publishes or shares it.
 */
export const TemporaryCanvases = ({ session, api, viewer, sessionWorkspace }: {
  session: RpcStub<OperateSession>
  api: RpcStub<AuthenticatedApi>
  viewer: object | null
  sessionWorkspace: RpcStub<Overseer> | null
}) => {
  const [attempt, setAttempt] = useState(0)
  const [shown, setShown] = useState<Shown>()
  const [open, setOpen] = useState<TemporaryCanvas | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; alert: boolean } | null>(null)

  useEffect(() => {
    let cancelled = false
    session.listTemporaryCanvases().then(
      canvases => { if (!cancelled) setShown({ session, attempt, state: { status: 'ready', canvases } }) },
      caught => {
        if (cancelled) return
        if (codeOf(caught) === TEMPORARY_CANVAS_ERROR_CODES.unavailable) {
          setShown({ session, attempt, state: { status: 'unavailable' } })
          return
        }
        console.error('Failed to list temporary canvases:', caught)
        setShown({ session, attempt, state: { status: 'error' } })
      })
    return () => { cancelled = true }
  }, [session, attempt])
  // Only this session's answer to this attempt is shown: a new one never shows the last.
  const state: ListState = shown && shown.session === session && shown.attempt === attempt ? shown.state : { status: 'loading' }
  const canvases = state.status === 'ready' ? state.canvases : []
  const now = useNowAtExpiry(canvases)

  const reload = () => setAttempt(n => n + 1)
  /** Runs one of the person's own actions; a refusal is said in its own words and the list read again. */
  const act = async (work: () => Promise<string | null>) => {
    setBusy(true)
    setNotice(null)
    try {
      const done = await work()
      if (done) setNotice({ text: done, alert: false })
    } catch (caught) {
      const code = codeOf(caught)
      const refusal = code ? REFUSALS[code] : undefined
      if (!refusal) console.error('A temporary canvas action failed:', caught)
      setNotice({ text: refusal ?? 'That didn’t work. Try again.', alert: true })
      if (code === TEMPORARY_CANVAS_ERROR_CODES.unavailable) setShown({ session, attempt, state: { status: 'unavailable' } })
      setOpen(null)
      reload()
    } finally {
      setBusy(false)
    }
  }

  const openCanvas = (canvas: TemporaryCanvas) => act(async () => {
    setOpen(await session.getTemporaryCanvas(canvas.id))
    return null
  })
  const save = (canvas: TemporaryCanvas) => act(async () => {
    const saved = await session.saveTemporaryCanvas(canvas.id, canvas.revision)
    setShown({ session, attempt, state: { status: 'ready', canvases: canvases.map(c => c.id === saved.id ? saved : c) } })
    if (open?.id === saved.id) setOpen(saved)
    return `Saved “${saved.title}”. It no longer expires.`
  })
  const remove = (canvas: TemporaryCanvas) => act(async () => {
    await session.removeTemporaryCanvas(canvas.id, canvas.revision)
    setConfirming(null)
    if (open?.id === canvas.id) setOpen(null)
    setShown({ session, attempt, state: { status: 'ready', canvases: canvases.filter(c => c.id !== canvas.id) } })
    return `Removed “${canvas.title}”. Nothing it showed was changed.`
  })

  return <section aria-labelledby="temporary-canvases-heading" className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <h2 id="temporary-canvases-heading" className="m-0 min-w-0 flex-1 text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">From your Dot</h2>
      {state.status === 'ready' && <Button size="sm" variant="ghost" disabled={busy} onClick={reload}>Refresh</Button>}
    </div>
    <p className="m-0 text-[13px] leading-[18px] text-kumo-subtle">
      Canvases your Dot composed and you approved. Each is temporary until you save it, and is only yours; removing or
      losing one changes nothing it shows.
    </p>
    {notice && <div role={notice.alert ? 'alert' : 'status'}
      className={`flex flex-wrap items-center gap-2 text-sm ${notice.alert ? 'text-kumo-danger' : 'text-kumo-default'}`}>
      <span className="min-w-0 flex-1">{notice.text}</span>
      <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>
    </div>}

    {state.status === 'loading' && <p role="status" className="m-0 text-sm text-kumo-subtle">Loading your temporary canvases…</p>}
    {state.status === 'error' && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
      <p className="m-0 text-kumo-danger">Couldn’t load your temporary canvases.</p>
      <Button size="sm" onClick={reload}>Try again</Button>
    </div>}
    {state.status === 'unavailable' && <p role="status" className="m-0 text-sm text-kumo-subtle">
      Temporary canvases are kept in your own Operate session. Open Operate as yourself to see yours.
    </p>}
    {state.status === 'ready' && canvases.length === 0 && <p className="m-0 rounded-xl border border-dashed border-kumo-line p-6 text-center text-sm text-kumo-subtle">
      No temporary canvases. Ask your Dot to compose one; you approve it here before it appears.
    </p>}

    {canvases.length > 0 && <ul className="m-0 space-y-2 p-0">
      {canvases.map(canvas => {
        const expired = expiredAt(canvas, now)
        const isOpen = open?.id === canvas.id && !expired
        return <li key={canvas.id} className="list-none space-y-3 rounded-lg border border-kumo-line bg-kumo-base p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <p className="m-0 min-w-0 flex-1">
              <span className="font-medium">{canvas.title}</span>
              <span className="text-kumo-subtle">
                {' '}· {canvas.placements.length} widget{canvas.placements.length === 1 ? '' : 's'}
              </span>
            </p>
            {canvas.expiresAt === undefined && <Badge variant="secondary">Saved</Badge>}
          </div>
          {canvas.expiresAt !== undefined && (expired
            ? <p className="m-0 text-[12px] leading-4 text-kumo-subtle">
                Expired <time dateTime={new Date(canvas.expiresAt).toISOString()}>{new Date(canvas.expiresAt).toLocaleString()}</time>.
                {' '}{TEMPORARY_CANVAS_EXPIRED}
              </p>
            : <p className="m-0 text-[12px] leading-4 text-kumo-warning">
                Temporary · expires{' '}
                <time dateTime={new Date(canvas.expiresAt).toISOString()}>{new Date(canvas.expiresAt).toLocaleString()}</time>
                {' '}unless saved
              </p>)}
          {!expired && <div className="flex flex-wrap items-center gap-2">
                {isOpen
                  ? <Button size="sm" disabled={busy} onClick={() => setOpen(null)}>Close</Button>
                  : <Button size="sm" disabled={busy} onClick={() => void openCanvas(canvas)}>Open</Button>}
                {canvas.expiresAt !== undefined &&
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void save(canvas)}>Save</Button>}
                {confirming === canvas.id
                  ? <>
                      <span className="text-kumo-subtle">Remove “{canvas.title}”? Nothing it shows is changed.</span>
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove(canvas)}>Remove</Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>Keep it</Button>
                    </>
                  : <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(canvas.id)}>Remove…</Button>}
          </div>}
          {isOpen && open && <OpenCanvas canvas={open} api={api} viewer={viewer} session={session} sessionWorkspace={sessionWorkspace} />}
        </li>
      })}
    </ul>}
  </section>
}
