import { useEffect, useState } from 'react'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { CANVAS_GADGET_REF } from '@gadgets/workshop-shared/canvas'
import type { CanvasNode } from '@gadgets/workshop-shared/canvas-model'

/** Where the workspace's triggers are read from (`Overseer.listHooks`). */
export type HookLister = Pick<Overseer, 'listHooks'>

/** The triggers a gadget widget's gadget binds, each by hook id and title. */
export type GadgetRunTriggers =
  | { status: 'loading' }
  | { status: 'ready'; triggers: { id: number; title: string }[] }
  | { status: 'unavailable'; message: string }

/**
 * The triggers bound on a selected `inferos.gadget` widget's own gadget (FAC-116), whose run
 * results an attachment on it may hear. Null for any other node. Publication checks the same
 * binding against the gadget it freezes, so this only offers them sooner.
 */
export const useGadgetRunTriggers = (lister: HookLister, node: CanvasNode | undefined): GadgetRunTriggers | null => {
  const match = node?.nodeType === 'widget' && node.kind === 'inferos.gadget' ? CANVAS_GADGET_REF.exec(node.targetRef) : null
  const gadgetId = match ? Number(match[1]) : null
  const [read, setRead] = useState<{ lister: HookLister; gadgetId: number; triggers: GadgetRunTriggers } | null>(null)

  useEffect(() => {
    if (gadgetId === null) return
    let current = true
    Promise.resolve().then(() => lister.listHooks()).then(
      hooks => {
        if (!current) return
        const triggers = hooks.filter(hook => hook.gadgetId === gadgetId).map(hook => ({ id: hook.id, title: hook.description.title }))
        setRead({ lister, gadgetId, triggers: { status: 'ready', triggers } })
      },
      (error: unknown) => {
        if (current) setRead({ lister, gadgetId, triggers: { status: 'unavailable', message: `This gadget's triggers couldn't be read: ${(error as Error).message}` } })
      })
    return () => { current = false }
  }, [lister, gadgetId])

  if (gadgetId === null) return null
  return read?.lister === lister && read.gadgetId === gadgetId ? read.triggers : { status: 'loading' }
}
