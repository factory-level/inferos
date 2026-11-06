import { useEffect, useState } from 'react'
import { Banner, Loader, Text } from '@cloudflare/kumo'
import { RpcTarget, type RpcStub } from 'capnweb'
import type { AuthoredWidgetPreview as PreviewResult, ConsoleLogEvent, GadgetClient, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import GadgetUI from '../../GadgetUI'
import { WorkshopButton } from '../../components/WorkshopControls'

/** The one workspace call the preview makes: it is never handed anything that could change state. */
export type PreviewOverseer = Pick<Overseer, 'previewAuthoredWidget'>

type Build =
  | { key: string; state: 'ready'; preview: PreviewResult; client: RpcStub<GadgetClient> }
  | { key: string; state: 'refused'; message: string }
  | { key: string; state: 'unauthorized'; message: string }

// The kernel's denials for the use role and operate sessions start this way (`#deny`).
const UNAUTHORIZED = 'Unauthorized: '
const MAX_LISTED_CALLS = 20
// Asked of a connection by `await` and by GadgetUI's own bookkeeping, never by the widget.
const NOT_CALLS = new Set(['then', 'onRpcBroken'])

const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

const refusalOf = (key: string, caught: unknown): Build => {
  const message = caught instanceof Error && caught.message ? caught.message : 'The preview could not be built.'
  return message.startsWith(UNAUTHORIZED)
    ? { key, state: 'unauthorized', message: message.slice(UNAUTHORIZED.length) }
    : { key, state: 'refused', message }
}

/**
 * What the preview frame reaches instead of the gadget's server: every method it calls is recorded by
 * name and answers `undefined`. Nothing is forwarded, so a preview can't reach a real binding or change
 * any state, whatever the authored code does.
 */
const mockServer = (record: (method: string) => void) => new Proxy<RpcTarget>(new RpcTarget(), {
  get: (target, property, receiver) => typeof property === 'symbol' || property in target || NOT_CALLS.has(property)
    ? Reflect.get(target, property, receiver)
    : () => { record(property); return undefined },
})

/**
 * The client the existing Gadget host (`GadgetUI`) runs the preview through, so the preview gets the
 * same sandboxed frame and handshake as every gadget UI and no frame of its own: its UI bundle is the
 * server-built module, and its connection is the mock server.
 */
const previewClient = (jsCode: string, record: (method: string) => void) => ({
  getUiBundle: async () => ({ jsCode }),
  connectToGadget: async () => mockServer(record),
}) as unknown as RpcStub<GadgetClient>

/**
 * The live preview of an authored widget: the selected chat's TSX/CSS draft, compiled by the server's
 * isolated build (`previewAuthoredWidget`, which stores nothing) and run in the Gadget frame, connected
 * to mock bindings only. A refusal is shown in the server's words.
 */
export const AuthoredWidgetPreview = ({ overseer, gadgetId, chatId, reloadTrigger, onConsoleLog }: {
  overseer: PreviewOverseer
  gadgetId: WorkpieceId
  /** The chat whose draft to build; absent when no chat is changing this gadget. */
  chatId: number | undefined
  /** Bumped by every code change, so the preview builds the draft again. */
  reloadTrigger: number
  onConsoleLog?: (log: ConsoleLogEvent) => void
}) => {
  const [retries, setRetries] = useState(0)
  const key = `${gadgetId}/${chatId}/${reloadTrigger}/${retries}`
  const [build, setBuild] = useState<Build | null>(null)
  const current = build?.key === key ? build : null
  const [calls, setCalls] = useState<{ key: string; methods: string[] }>({ key, methods: [] })
  const methods = calls.key === key ? calls.methods : []

  useEffect(() => {
    if (chatId === undefined) return
    let stale = false
    const record = (method: string) => setCalls(previous => ({
      key,
      methods: [...(previous.key === key ? previous.methods : []), method].slice(-MAX_LISTED_CALLS),
    }))
    overseer.previewAuthoredWidget(gadgetId, chatId).then(
      preview => { if (!stale) setBuild({ key, state: 'ready', preview, client: previewClient(preview.jsCode, record) }) },
      caught => { if (!stale) setBuild(refusalOf(key, caught)) })
    return () => { stale = true }
  }, [overseer, gadgetId, chatId, key])

  if (chatId === undefined) {
    return <div className="flex h-full items-center justify-center p-6 text-center">
      <div className="max-w-sm space-y-1">
        <Text>Nothing to preview yet</Text>
        <Text variant="secondary">A preview builds a chat's draft of this widget. Open the chat that is changing it.</Text>
      </div>
    </div>
  }

  if (!current) {
    return <div role="status" className="flex h-full flex-col items-center justify-center gap-3">
      <Loader size="lg" />
      <Text variant="secondary">Building the preview…</Text>
    </div>
  }

  if (current.state === 'unauthorized') {
    return <div role="alert" className="flex h-full items-center justify-center p-5">
      <Banner variant="error" title="You can't build a preview" description={current.message} />
    </div>
  }

  if (current.state === 'refused') {
    return <div role="alert" className="flex h-full items-center justify-center p-5">
      <Banner variant="error" title="The preview wasn't built" description={current.message}
        action={<Banner.Action onClick={() => setRetries(count => count + 1)}>Try again</Banner.Action>} />
    </div>
  }

  const { measurements } = current.preview
  return <div className="flex h-full flex-col">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-line px-3 py-2">
      <Text variant="secondary" size="sm">
        Built in {measurements.durationMs} ms · {formatBytes(measurements.clientBytes)}. Bindings are mocks: calls are listed below and change nothing.
      </Text>
      <WorkshopButton onClick={() => setRetries(count => count + 1)}>Rebuild</WorkshopButton>
    </div>
    <div className="min-h-0 flex-1">
      <GadgetUI key={key} gadget={current.client} height="100%" onConsoleLog={onConsoleLog} />
    </div>
    <div className="border-t border-kumo-line px-3 py-2">
      <Text variant="secondary" size="sm">Calls from the preview</Text>
      {methods.length === 0
        ? <Text variant="secondary" size="sm">None yet.</Text>
        : <ul aria-label="Calls from the preview" className="mt-1 flex flex-wrap gap-1.5">
          {methods.map((method, index) => <li key={index} className="rounded bg-kumo-control px-1.5 py-0.5 font-mono text-xs text-kumo-default">{method}</li>)}
        </ul>}
    </div>
  </div>
}
