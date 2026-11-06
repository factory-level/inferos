import { useEffect, useState } from 'react'
import type { FileAtCommit, GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import { CANVAS_GADGET_REF } from '@gadgets/workshop-shared/canvas'
import type { CanvasNode } from '@gadgets/workshop-shared/canvas-model'
import { parseWidgetStates, WIDGET_STATES_FILE } from '@gadgets/workshop-shared/widget-state'
import { commitFileStore, type CommitFileReader } from '../code/commitFileStore'

/** What a gadget widget's own events are, as its head commit's `states.json` declares them. */
export type GadgetWidgetEvents =
  | { status: 'loading' }
  | { status: 'ready'; events: string[] }
  | { status: 'none' }
  | { status: 'unavailable'; message: string }

// The transition events `file` declares, each once, in declaration order.
const fromFile = (file: FileAtCommit | undefined): GadgetWidgetEvents => {
  if (!file || file.kind === 'absent') return { status: 'none' }
  if (file.kind === 'unreadable') return { status: 'unavailable', message: file.message }
  try {
    return { status: 'ready', events: [...new Set(parseWidgetStates(file.text).transitions.map(transition => transition.event))] }
  } catch (error) {
    return { status: 'unavailable', message: `This widget's states.json isn't valid: ${(error as Error).message}` }
  }
}

/**
 * The events a selected `inferos.gadget` widget declares (FAC-94), which an attachment on it may
 * listen for, read from the placed gadget's head commit. Null for any other node. Publication
 * checks the same events against the commit it freezes, so this only offers them sooner.
 */
export const useGadgetWidgetEvents = (reader: CommitFileReader, gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>,
    node: CanvasNode | undefined): GadgetWidgetEvents | null => {
  const match = node?.nodeType === 'widget' && node.kind === 'inferos.gadget' ? CANVAS_GADGET_REF.exec(node.targetRef) : null
  const commitId = match ? gadgets.get(Number(match[1]))?.commitId ?? null : null
  const [read, setRead] = useState<{ commitId: string; events: GadgetWidgetEvents } | null>(null)

  useEffect(() => {
    if (commitId === null) return
    let current = true
    commitFileStore.readFiles(reader, commitId, [WIDGET_STATES_FILE]).then(
      files => { if (current) setRead({ commitId, events: fromFile(files.get(WIDGET_STATES_FILE)) }) },
      (error: unknown) => {
        if (current) setRead({ commitId, events: { status: 'unavailable', message: `This widget's events couldn't be read: ${(error as Error).message}` } })
      })
    return () => { current = false }
  }, [reader, commitId])

  if (!match) return null
  if (commitId === null) return { status: 'unavailable', message: 'This widget\'s gadget is not in this workspace.' }
  return read?.commitId === commitId ? read.events : { status: 'loading' }
}
