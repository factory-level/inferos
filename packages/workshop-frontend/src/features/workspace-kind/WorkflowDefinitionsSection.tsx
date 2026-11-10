import { useState } from 'react'
import { Input, Select, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { GadgetSummary, Overseer } from '@gadgets/workshop-shared/api'
import {
  MAX_WORKFLOW_DEFINITION_TITLE_LENGTH,
  type WorkflowDefinition,
} from '@gadgets/workshop-shared/workflow-definition'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../../components/WorkshopControls'

type Props = {
  overseer: RpcStub<Overseer>
  // The workspace's gadgets: a definition is saved from one of them, at its current code.
  gadgets: readonly GadgetSummary[]
  definitions: readonly WorkflowDefinition[]
  // Called after a save or publish, so the panel reloads definitions and pins.
  onChanged: () => void
}

/** The server's refusal as it words it, when it has one. */
const refusalOf = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback

/**
 * A workflow's saved definitions: save the workflow's current code as a revision, and publish one
 * revision for everyone else. Saving publishes nothing. The list shows what the server lets this
 * person see: their own definitions with every revision, others' only at the published revision.
 * The server decides who may save and publish; a refusal is shown in its words. A dynamic,
 * unsaved definition (FAC-124: one the Dot or an agent made with `retain: false`) says it is
 * temporary and when it expires, and its owner's save keeps it; after that it is gone for new use.
 */
export const WorkflowDefinitionsSection = ({ overseer, gadgets, definitions, onChanged }: Props) => {
  const toasts = useKumoToastManager()
  const { currentUser } = useAuthenticatedApi()
  const [title, setTitle] = useState('')
  const [gadgetId, setGadgetId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const chosenGadget = gadgetId ?? gadgets[0]?.id ?? null
  const trimmed = title.trim()

  const run = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true)
    try {
      await work()
      onChanged()
    } catch (err) {
      toasts.add({ title: refusalOf(err, failure), variant: 'error' })
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
        Save this workflow&apos;s current code as a revision to reuse it. Saving keeps it for you
        alone; publishing a revision makes it available to everyone who uses this workspace.
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
            const canPublish = own && latest !== undefined && latest.revision !== published
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
                  {definition.expiresAt && (
                    <p className="mt-0.5 mb-0 text-[12px] leading-4 text-kumo-warning">
                      Temporary · expires{' '}
                      <time dateTime={definition.expiresAt.toISOString()}>{definition.expiresAt.toLocaleString()}</time>
                      {' '}unless saved
                    </p>
                  )}
                </div>
                {own && (
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
    </section>
  )
}
