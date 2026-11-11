import { useState } from 'react'
import { Dialog, Input, useKumoToastManager } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { MAX_WORKFLOW_DEFINITION_TITLE_LENGTH, type WorkflowDefinition } from '@gadgets/workshop-shared/workflow-definition'
import { WorkshopButton, WorkshopIconButton } from '../../components/WorkshopControls'
import { copyTitle } from './duplicateText'

type Props = {
  overseer: RpcStub<Overseer>
  /** The definition being copied: one this person can see. */
  source: WorkflowDefinition
  onClose: () => void
  /** Called with the new copy, which is this person's own. */
  onDuplicated: (copy: WorkflowDefinition) => void
}

/** The server's refusal as it words it, when it has one. */
const refusalOf = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback

/**
 * Duplicate a workflow definition into one of this person's own (FAC-123): only its title is asked.
 * The server decides the rest (who may, and which revision is copied) and a refusal is shown in its
 * words. The copy carries none of the source's connections, so it says it can't run until they are
 * set up, which its owner does next.
 */
export const DuplicateWorkflowDialog = ({ overseer, source, onClose, onDuplicated }: Props) => {
  const toasts = useKumoToastManager()
  const [title, setTitle] = useState(() => copyTitle(source.title))
  const [busy, setBusy] = useState(false)
  const trimmed = title.trim()

  const duplicate = async () => {
    setBusy(true)
    try {
      onDuplicated(await overseer.duplicateWorkflowDefinition({ sourceId: source.id, title: trimmed }))
    } catch (err) {
      toasts.add({ title: refusalOf(err, "Couldn't duplicate the workflow."), variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog className="responsive-dialog !w-[min(560px,calc(100vw-32px))] bg-kumo-base p-0" size="lg">
        <div className="flex items-start justify-between gap-4 px-4 pb-3 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <Dialog.Title className="truncate text-[18px] leading-6 font-medium tracking-[-0.4px] text-kumo-default">
              Duplicate “{source.title}”
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              The copy is a new workflow of your own. Later changes to “{source.title}” never reach it, and
              nothing else comes with it: no sharing, publication, trigger or connection. It can&apos;t run
              until you set up its connections from your own accounts and models.
            </Dialog.Description>
          </div>
          <Dialog.Close render={(props) => (
            <WorkshopIconButton {...props} aria-label="Close"><X size={18} /></WorkshopIconButton>
          )} />
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 pb-6 sm:px-6">
          <Input
            aria-label="Copy title"
            className="min-w-0 flex-1"
            value={title}
            maxLength={MAX_WORKFLOW_DEFINITION_TITLE_LENGTH}
            onChange={(e) => setTitle(e.target.value)}
          />
          <WorkshopButton disabled={busy || !trimmed} onClick={() => void duplicate()}>Duplicate</WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
