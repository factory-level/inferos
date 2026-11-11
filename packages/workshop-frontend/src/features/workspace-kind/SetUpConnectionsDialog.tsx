import { useEffect, useRef, useState } from 'react'
import { Dialog, Select, useKumoToastManager } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo, BlueprintBindingAssignment, GatekeeperVendorInfo, Overseer,
} from '@gadgets/workshop-shared/api'
import type { WorkflowDefinition, WorkflowRequiredBinding } from '@gadgets/workshop-shared/workflow-definition'
import { useAuthenticatedApi } from '../../AuthContext'
import { GatekeeperBindingField } from '../../components/GatekeeperBindingField'
import { WorkshopButton, WorkshopIconButton } from '../../components/WorkshopControls'
import { openConnectWindow } from '../../connectHandoff'
import { unmetText } from './duplicateText'
import { useConnectedAccounts } from './useConnectedAccounts'

type Props = {
  overseer: RpcStub<Overseer>
  /** The owner's own definition, with the connections it still needs (`bindingsNeeded`). */
  definition: WorkflowDefinition
  onClose: () => void
  /** Called once connections were set up, so the list reloads what the server now holds. */
  onSetUp: () => void
}

/** What this person has chosen for one connection so far. */
type Choice = { accountId?: number; modelId?: string }

/**
 * One list this dialog reads (the gatekeeper vendors, the person's models): still loading, failed
 * with what went wrong, or read. An empty list is only ever one that was read, so a failed request
 * never reads as "you have none".
 */
type ListState<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: T[] }

/** The server's refusal as it words it, when it has one. */
const refusalOf = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback

const nameOf = (binding: WorkflowRequiredBinding) => binding.title || binding.name

/**
 * Set up the connections a definition needs before it can run (FAC-123), for its owner only: each
 * required connection, filled from this person's own connected account and a resource, or one of
 * their own models. Nothing of the definition it was copied from is offered. Any it leaves stay to
 * set up. The server checks each as at install, all of them before any is made, and a refusal is
 * shown in its words.
 */
export const SetUpConnectionsDialog = ({ overseer, definition, onClose, onSetUp }: Props) => {
  const toasts = useKumoToastManager()
  const { authenticatedApi } = useAuthenticatedApi()
  const accounts = useConnectedAccounts(authenticatedApi)
  const [vendors, setVendors] = useState<ListState<GatekeeperVendorInfo>>({ status: 'loading' })
  const [models, setModels] = useState<ListState<AiChatAuthorInfo>>({ status: 'loading' })
  // Bumped to read the lists again after a failure.
  const [attempt, setAttempt] = useState(0)
  const [choices, setChoices] = useState<Readonly<Record<string, Choice>>>({})
  const [ready, setReady] = useState<Readonly<Record<string, boolean>>>({})
  const [connecting, setConnecting] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  // Each gatekeeper connection's resource picker hands over a way to read what was picked, used on save.
  const collectors = useRef(new Map<string, () => Promise<string>>())
  const needed = definition.bindingsNeeded ?? []

  useEffect(() => {
    let cancelled = false
    setVendors(prev => prev.status === 'ready' ? prev : { status: 'loading' })
    setModels(prev => prev.status === 'ready' ? prev : { status: 'loading' })
    authenticatedApi.listGatekeeperVendors().then(
      items => { if (!cancelled) setVendors({ status: 'ready', items }) },
      err => { if (!cancelled) setVendors({ status: 'error', message: refusalOf(err, "Couldn't read the connection types.") }) },
    )
    authenticatedApi.listModels().then(
      items => { if (!cancelled) setModels({ status: 'ready', items }) },
      err => { if (!cancelled) setModels({ status: 'error', message: refusalOf(err, "Couldn't read your models.") }) },
    )
    return () => { cancelled = true }
  }, [authenticatedApi, attempt])

  const retry = () => setAttempt(n => n + 1)

  // A reconnect is over once the account reads as valid again.
  const reconnectingAccountId =
    reconnecting !== null && accounts.some(a => a.id === reconnecting && a.credentialsValid) ? null : reconnecting

  const choose = (name: string, update: Choice) => setChoices(prev => ({ ...prev, [name]: { ...prev[name], ...update } }))

  const connect = async (vendorId: string) => {
    setConnecting(vendorId)
    try {
      openConnectWindow(await authenticatedApi.connectAccount(vendorId))
      toasts.add({ title: 'Complete the account connection in the pop-up window.', variant: 'success' })
    } catch (err) {
      toasts.add({ title: refusalOf(err, "Couldn't start connecting the account."), variant: 'error' })
    } finally {
      setConnecting(null)
    }
  }

  const reconnect = async (accountId: number) => {
    setReconnecting(accountId)
    try {
      openConnectWindow(await authenticatedApi.reconnectAccount(accountId))
      toasts.add({ title: 'Complete the account reconnect in the pop-up window.', variant: 'success' })
    } catch (err) {
      toasts.add({ title: refusalOf(err, "Couldn't start reconnecting the account."), variant: 'error' })
      setReconnecting(null)
    }
  }

  // The connections chosen in full: an account whose resource picker is ready, or a model.
  const chosen = needed.filter(binding => binding.type === 'gatekeeper'
    ? choices[binding.name]?.accountId !== undefined && ready[binding.name] === true
    : choices[binding.name]?.modelId !== undefined)

  const save = async () => {
    setBusy(true)
    try {
      const assignments: Record<string, BlueprintBindingAssignment> = {}
      for (const binding of chosen) {
        const choice = choices[binding.name]!
        if (binding.type === 'aiModel') {
          assignments[binding.name] = { type: 'aiModel', modelId: choice.modelId! }
          continue
        }
        const collect = collectors.current.get(binding.name)
        if (!collect) throw new Error(`Choose a resource for “${nameOf(binding)}” again.`)
        assignments[binding.name] = { type: 'gatekeeper', accountId: choice.accountId!, resourceUrl: await collect() }
      }
      await overseer.rebindWorkflowDefinition(definition.id, assignments)
      onSetUp()
    } catch (err) {
      toasts.add({ title: refusalOf(err, "Couldn't set up the connections."), variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog className="responsive-dialog !w-[min(640px,calc(100vw-32px))] bg-kumo-base p-0" size="lg">
        <div className="flex items-start justify-between gap-4 px-4 pb-3 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <Dialog.Title className="truncate text-[18px] leading-6 font-medium tracking-[-0.4px] text-kumo-default">
              Set up connections for “{definition.title}”
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              It runs only once each of these is set up from your own connected accounts and models. Nothing
              of the workflow it was copied from is used.
            </Dialog.Description>
          </div>
          <Dialog.Close render={(props) => (
            <WorkshopIconButton {...props} aria-label="Close"><X size={18} /></WorkshopIconButton>
          )} />
        </div>

        <div className="space-y-5 px-4 pb-6 sm:px-6">
          {needed.length === 0 && (
            <p className="m-0 text-[13px] text-kumo-subtle">Its connections are all set up.</p>
          )}
          {needed.map(binding => (
            <section key={binding.name} aria-label={nameOf(binding)} className="space-y-2">
              <div>
                <h3 className="m-0 text-[13px] leading-[18px] font-medium text-kumo-default">{nameOf(binding)}</h3>
                <p className="m-0 text-[12px] leading-4 text-kumo-subtle">{unmetText(binding)}</p>
              </div>
              {binding.type === 'gatekeeper' ? (vendors.status !== 'ready' ? (
                <ListNotReady state={vendors} loading="Reading the connection types…" onRetry={retry} />
              ) : (
                <GatekeeperBindingField
                  title={nameOf(binding)}
                  binding={{ gatekeeperName: binding.vendorId, typeUrlPattern: binding.typeUrlPattern }}
                  value={{ accountId: choices[binding.name]?.accountId } as Partial<BlueprintBindingAssignment>}
                  authenticatedApi={authenticatedApi}
                  vendors={vendors.items}
                  accounts={accounts}
                  connectingVendor={connecting}
                  reconnectingAccountId={reconnectingAccountId}
                  onChange={(update) => choose(binding.name, { accountId: (update as { accountId?: number }).accountId })}
                  onConnectAccount={(vendorId) => void connect(vendorId)}
                  onReconnectAccount={(accountId) => void reconnect(accountId)}
                  onReadyChange={(isReady) => setReady(prev => ({ ...prev, [binding.name]: isReady }))}
                  onCollectorChange={(collect) => {
                    if (collect) collectors.current.set(binding.name, collect)
                    else collectors.current.delete(binding.name)
                  }}
                />
              )) : models.status !== 'ready' ? (
                <ListNotReady state={models} loading="Reading your models…" onRetry={retry} />
              ) : (
                <>
                  <Select
                    aria-label={`Model for ${nameOf(binding)}`}
                    className="w-full text-sm"
                    placeholder="Choose one of your models"
                    value={choices[binding.name]?.modelId}
                    onValueChange={(modelId) => choose(binding.name, { modelId: String(modelId) })}
                    disabled={models.items.length === 0}
                  >
                    {models.items.map(model => <Select.Option key={model.id} value={model.id}>{model.name}</Select.Option>)}
                  </Select>
                  {models.items.length === 0 && (
                    <p className="m-0 text-[12px] text-kumo-subtle">You have no models yet. Add one from AI Providers first.</p>
                  )}
                </>
              )}
            </section>
          ))}
          {needed.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <WorkshopButton disabled={busy || chosen.length === 0} onClick={() => void save()}>
                {chosen.length === needed.length || chosen.length === 0
                  ? 'Set up connections'
                  : `Set up ${chosen.length} of ${needed.length}`}
              </WorkshopButton>
              {chosen.length > 0 && chosen.length < needed.length && (
                <p className="m-0 text-[12px] text-kumo-subtle">The rest stay to set up, and it can&apos;t run until they are.</p>
              )}
            </div>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

/** A list still loading, or one that failed: said in words, with a way to read it again. */
const ListNotReady = ({ state, loading, onRetry }: {
  state: { status: 'loading' } | { status: 'error'; message: string }
  loading: string
  onRetry: () => void
}) => state.status === 'loading' ? (
  <p className="m-0 text-[12px] text-kumo-subtle" role="status">{loading}</p>
) : (
  <div className="flex flex-wrap items-center gap-2" role="alert">
    <p className="m-0 text-[12px] text-kumo-danger">{state.message}</p>
    <WorkshopButton onClick={onRetry}>Try again</WorkshopButton>
  </div>
)
