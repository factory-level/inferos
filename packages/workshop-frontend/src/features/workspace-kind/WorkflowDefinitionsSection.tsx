import { useState } from 'react'
import { Input, Select, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { CollaboratorInfo, GadgetSummary, Overseer } from '@gadgets/workshop-shared/api'
import {
  MAX_WORKFLOW_DEFINITION_TITLE_LENGTH,
  WORKFLOW_DEFINITION_EXPIRED,
  type WorkflowDefinition,
} from '@gadgets/workshop-shared/workflow-definition'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../../components/WorkshopControls'
import { ShareWorkflowDialog, describeRights } from './ShareWorkflowDialog'

type Props = {
  overseer: RpcStub<Overseer>
  // The workspace's gadgets: a definition is saved from one of them, at its current code.
  gadgets: readonly GadgetSummary[]
  definitions: readonly WorkflowDefinition[]
  // The workspace's collaborators, whom an owner may share a definition with by account (FAC-122).
  collaborators?: readonly CollaboratorInfo[]
  // Called after a save or publish, so the panel reloads definitions and pins.
  onChanged: () => void
}

/** The server's refusal as it words it, when it has one. */
const refusalOf = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback

/** Whether the server refused because the definition expired first (a save that lost the race). */
const isExpired = (err: unknown) => err instanceof Error && err.message.includes(WORKFLOW_DEFINITION_EXPIRED)

/** What a person is told when a temporary definition expired before their save: never "not found". */
const EXPIRED_BEFORE_SAVE =
  "This temporary definition expired before it was saved, so it's gone for new use. Runs it " +
  'already started stay in their history. Save the workflow again to keep a new definition.'

/**
 * A workflow's saved definitions: save the workflow's current code as a revision, and publish one
 * revision for everyone else. Saving publishes nothing. The list shows what the server lets this
 * person see: their own definitions with every revision, others' only at the published revision.
 * The server decides who may save and publish; a refusal is shown in its words. A dynamic,
 * unsaved definition (FAC-124: one the Dot or an agent made with `retain: false`) says it is
 * temporary and when it expires, and its owner's save keeps it; after that it is gone for new use.
 * An owner shares a saved definition with people of the workspace, by account (FAC-122); one shared
 * with this person says so and what it lets them do, and an editor saves new revisions, which its
 * owner publishes.
 */
export const WorkflowDefinitionsSection = ({ overseer, gadgets, definitions, collaborators = [], onChanged }: Props) => {
  const toasts = useKumoToastManager()
  const { currentUser } = useAuthenticatedApi()
  const [title, setTitle] = useState('')
  const [gadgetId, setGadgetId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [sharing, setSharing] = useState<WorkflowDefinition | null>(null)
  const chosenGadget = gadgetId ?? gadgets[0]?.id ?? null
  const trimmed = title.trim()

  const run = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true)
    try {
      await work()
      onChanged()
    } catch (err) {
      if (isExpired(err)) {
        toasts.add({ title: EXPIRED_BEFORE_SAVE, variant: 'error' })
        // It is gone for new use now, so reload: it leaves the list.
        onChanged()
      } else {
        toasts.add({ title: refusalOf(err, failure), variant: 'error' })
      }
    } finally {
      setBusy(false)
    }
  }

  // A new definition saves the chosen gadget; a new revision saves the gadget its definition is for.
  const save = (existing?: WorkflowDefinition) => {
    const gadget = existing
      ? existing.revisions[existing.revisions.length - 1]?.source.gadgetId ?? null
      : chosenGadget
    const saveTitle = existing ? existing.title : trimmed
    if (gadget === null || !saveTitle) return
    void run(async () => {
      await overseer.saveWorkflowDefinition({
        ...(existing ? { id: existing.id } : {}), title: saveTitle, gadgetId: gadget,
      })
      if (!existing) setTitle('')
    }, "Couldn't save the workflow definition.")
  }

  const publish = (definition: WorkflowDefinition, revision: number) => {
    void run(() => overseer.publishWorkflowDefinition(definition.id, revision),
      "Couldn't publish the workflow definition.")
  }

  return (
    <section aria-labelledby="workflow-definitions-heading" className="mt-8">
      <h2
        id="workflow-definitions-heading"
        className="m-0 text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default"
      >
        Definitions
      </h2>
      <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
        Save this workflow&apos;s current code as a revision to reuse it. Saving keeps it for you, and
        anyone you share it with for editing; publishing a revision makes it the one everyone else who
        may see it reads and runs.
      </p>

      {gadgets.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            aria-label="Definition title"
            className="min-w-0 flex-1"
            value={title}
            maxLength={MAX_WORKFLOW_DEFINITION_TITLE_LENGTH}
            placeholder="Definition title"
            onChange={(e) => setTitle(e.target.value)}
          />
          {gadgets.length > 1 && (
            <Select
              aria-label="Workflow to save"
              className="text-sm"
              value={chosenGadget === null ? undefined : String(chosenGadget)}
              onValueChange={(value) => setGadgetId(Number(value))}
            >
              {gadgets.map(gadget => (
                <Select.Option key={gadget.id} value={String(gadget.id)}>{gadget.title}</Select.Option>
              ))}
            </Select>
          )}
          <WorkshopButton disabled={busy || !trimmed} onClick={() => save()}>Save</WorkshopButton>
        </div>
      )}

      {definitions.length === 0 ? (
        <p className="mt-3 mb-0 text-[13px] text-kumo-subtle">No saved definitions yet.</p>
      ) : (
        <ul className="mt-3 mb-0 list-none overflow-hidden rounded-xl border border-kumo-line bg-kumo-base p-0">
          {definitions.map((definition, index) => {
            const latest = definition.revisions[definition.revisions.length - 1]
            const published = definition.published?.revision
            const own = currentUser !== null && definition.owner.id === currentUser.id
            // Its owner, or someone it was shared with for editing: they save new revisions.
            const edits = own || definition.access?.edit === true
            // Read at render: a definition whose expiry passed while shown can no longer be saved.
            const expired = definition.expiresAt !== undefined && definition.expiresAt.getTime() <= Date.now()
            // Publishing stays its owner's here: an editor may publish only where the deployment's
            // shared configuration is in force, which this page can't tell, and elsewhere the server
            // refuses it as not found, which would mislead.
            const canPublish = own && !expired && latest !== undefined && latest.revision !== published
            return (
              <li
                key={definition.id}
                className={`flex items-center gap-3 px-3 py-3 ${index > 0 ? 'border-t border-kumo-line' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                    {definition.title}
                  </p>
                  <p className="mt-0.5 mb-0 truncate text-[12px] leading-4 text-kumo-subtle">
                    {[
                      latest && `Revision ${latest.revision}`,
                      published === undefined ? 'Not published' : `Published: revision ${published}`,
                      definition.owner.name,
                    ].filter(Boolean).join(' · ')}
                  </p>
                  {!own && definition.sharedWithMe && definition.access && (
                    <p className="mt-0.5 mb-0 truncate text-[12px] leading-4 text-kumo-subtle">
                      Shared with you · you can {describeRights(definition.access)}
                    </p>
                  )}
                  {definition.expiresAt && (expired ? (
                    <p className="mt-0.5 mb-0 text-[12px] leading-4 text-kumo-subtle">
                      Expired{' '}
                      <time dateTime={definition.expiresAt.toISOString()}>{definition.expiresAt.toLocaleString()}</time>
                      : gone for new use. Runs it already started stay in their history.
                    </p>
                  ) : (
                    <p className="mt-0.5 mb-0 text-[12px] leading-4 text-kumo-warning">
                      Temporary · expires{' '}
                      <time dateTime={definition.expiresAt.toISOString()}>{definition.expiresAt.toLocaleString()}</time>
                      {' '}unless saved
                    </p>
                  ))}
                </div>
                {own && !definition.expiresAt && (
                  <WorkshopButton disabled={busy} onClick={() => setSharing(definition)}>Share</WorkshopButton>
                )}
                {edits && !expired && (
                  <WorkshopButton disabled={busy} onClick={() => save(definition)}>
                    {definition.expiresAt ? 'Save to keep' : 'Save new revision'}
                  </WorkshopButton>
                )}
                {canPublish && (
                  <WorkshopButton disabled={busy} onClick={() => publish(definition, latest.revision)}>
                    Publish revision {latest.revision}
                  </WorkshopButton>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {sharing && (
        <ShareWorkflowDialog overseer={overseer} definition={sharing} collaborators={collaborators}
          onClose={() => { setSharing(null); onChanged() }} />
      )}
    </section>
  )
}
