import { useEffect, useState } from 'react'
import { Checkbox, Dialog, Select, useKumoToastManager } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { CollaboratorInfo, Overseer } from '@gadgets/workshop-shared/api'
import type { WorkflowDefinition, WorkflowDefinitionRights, WorkflowDefinitionShare } from '@gadgets/workshop-shared/workflow-definition'
import { WorkshopButton, WorkshopIconButton } from '../../components/WorkshopControls'

type Props = {
  overseer: RpcStub<Overseer>
  /** The owner's own saved definition being shared. */
  definition: WorkflowDefinition
  /** The workspace's collaborators: a definition is shared only with one of them, by account. */
  collaborators: readonly CollaboratorInfo[]
  onClose: () => void
}

type Shares =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; shares: WorkflowDefinitionShare[] }

/** The rights as a person reads them; `run` and `edit` each include `read`. */
export const describeRights = (rights: WorkflowDefinitionRights): string =>
  [rights.edit ? 'edit' : null, rights.run ? 'run' : null, 'read'].filter(Boolean).join(', ')

/** The server's refusal as it words it, when it has one. */
const refusalOf = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback

/**
 * Share one owner-maintained workflow definition with people of this workspace, by their account
 * (FAC-122): who it is shared with and how, adding someone with read, run or edit, and stopping a
 * share. The server decides everything (owner only, collaborators only, edit only for someone who
 * builds) and a refusal is shown in its words. A share adds rights for that person; it never takes
 * away what the workspace already lets them do, so nothing here claims it restricts anyone.
 */
export const ShareWorkflowDialog = ({ overseer, definition, collaborators, onClose }: Props) => {
  const toasts = useKumoToastManager()
  const [shares, setShares] = useState<Shares>({ status: 'loading' })
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [person, setPerson] = useState<string | null>(null)
  const [rights, setRights] = useState<WorkflowDefinitionRights>({ read: true, run: false, edit: false })

  useEffect(() => {
    let cancelled = false
    setShares({ status: 'loading' })
    overseer.listWorkflowDefinitionShares(definition.id).then(
      list => { if (!cancelled) setShares({ status: 'ready', shares: list }) },
      () => { if (!cancelled) setShares({ status: 'error' }) })
    return () => { cancelled = true }
  }, [overseer, definition.id, reload])

  const shared = shares.status === 'ready' ? shares.shares : []
  // Anyone of the workspace but the owner, by account; each listed once, already shared or not.
  const candidates = collaborators.filter(c => c.profile.id !== definition.owner.id)
  const nameOf = (profileId: string) => candidates.find(c => c.profile.id === profileId)?.profile.name ?? profileId
  const chosen = candidates.find(c => c.profile.id === person) ?? null
  // Editing saves the workflow's code, which only someone who builds here can: the server refuses
  // it too, so it is offered only to them.
  const canEdit = chosen !== null && (chosen.role ?? 'build') === 'build'

  const change = async (profileId: string, next: WorkflowDefinitionRights | null, failure: string) => {
    setBusy(true)
    try {
      const list = await overseer.shareWorkflowDefinition(definition.id, profileId, next)
      setShares({ status: 'ready', shares: list })
      return true
    } catch (err) {
      toasts.add({ title: refusalOf(err, failure), variant: 'error' })
      return false
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    if (!chosen) return
    const next = { read: true, run: rights.run, edit: rights.edit && canEdit }
    if (await change(chosen.profile.id, next, "Couldn't share the workflow.")) {
      setPerson(null)
      setRights({ read: true, run: false, edit: false })
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog className="responsive-dialog !w-[min(560px,calc(100vw-32px))] bg-kumo-base p-0" size="lg">
        <div className="flex items-start justify-between gap-4 px-4 pb-3 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <Dialog.Title className="truncate text-[18px] leading-6 font-medium tracking-[-0.4px] text-kumo-default">
              Share “{definition.title}”
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              Share the definition you maintain with people of this workspace. Reading and running use its
              published revision, never your unpublished changes; editing shows every revision. A share adds
              what you choose for that person; it never removes what this workspace already lets them do,
              and it gives no access to records.
            </Dialog.Description>
          </div>
          <Dialog.Close render={(props) => (
            <WorkshopIconButton {...props} aria-label="Close"><X size={18} /></WorkshopIconButton>
          )} />
        </div>

        <div className="px-4 pb-6 sm:px-6">
          {shares.status === 'loading' && <p role="status" className="m-0 text-[13px] text-kumo-subtle">Loading who it's shared with…</p>}
          {shares.status === 'error' && (
            <div role="alert" className="flex items-center gap-2 text-[13px] text-kumo-danger">
              Couldn't load who it's shared with.
              <WorkshopButton onClick={() => setReload(n => n + 1)}>Try again</WorkshopButton>
            </div>
          )}
          {shares.status === 'ready' && (shared.length === 0
            ? <p className="m-0 text-[13px] text-kumo-subtle">Not shared with anyone by name yet.</p>
            : (
              <ul aria-label="Shared with" className="m-0 list-none overflow-hidden rounded-xl border border-kumo-line p-0">
                {shared.map((share, index) => (
                  <li key={share.profileId}
                    className={`flex items-center gap-3 px-3 py-2.5 ${index > 0 ? 'border-t border-kumo-line' : ''}`}>
                    <div className="min-w-0 flex-1">
                      <p className="m-0 truncate text-[13px] font-medium text-kumo-default">{nameOf(share.profileId)}</p>
                      <p className="m-0 truncate text-[12px] text-kumo-subtle">Can {describeRights(share.rights)}</p>
                    </div>
                    <WorkshopButton disabled={busy}
                      onClick={() => void change(share.profileId, null, "Couldn't stop sharing the workflow.")}>
                      Stop sharing
                    </WorkshopButton>
                  </li>
                ))}
              </ul>
            ))}

          {shares.status === 'ready' && (candidates.length === 0
            ? <p className="mt-4 mb-0 text-[13px] text-kumo-subtle">Add people to this workspace to share it with them.</p>
            : (
              <div className="mt-4 space-y-3">
                <Select aria-label="Person to share with" className="w-full text-sm"
                  value={person ?? undefined} placeholder="Choose a person"
                  onValueChange={(value) => setPerson(String(value))}>
                  {candidates.map(c => <Select.Option key={c.profile.id} value={c.profile.id}>{c.profile.name}</Select.Option>)}
                </Select>
                <div className="flex flex-wrap gap-4">
                  <Checkbox label="Read" checked disabled />
                  <Checkbox label="Run" checked={rights.run} onCheckedChange={(checked) => setRights(r => ({ ...r, run: checked === true }))} />
                  <Checkbox label="Edit" checked={rights.edit && canEdit} disabled={!canEdit}
                    onCheckedChange={(checked) => setRights(r => ({ ...r, edit: checked === true }))} />
                </div>
                {chosen && !canEdit && (
                  <p className="m-0 text-[12px] text-kumo-subtle">Only someone who can build in this workspace can edit a workflow.</p>
                )}
                <p className="m-0 text-[12px] text-kumo-subtle">
                  Running also needs the trigger's run control to list them. Editing lets them save new revisions,
                  which stay unpublished until published.
                </p>
                <WorkshopButton disabled={busy || !chosen} onClick={() => void add()}>Share</WorkshopButton>
              </div>
            ))}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
