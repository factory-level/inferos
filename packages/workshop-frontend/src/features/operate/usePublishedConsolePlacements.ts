import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { CANVAS_GADGET_REF } from '@gadgets/workshop-shared/canvas'

/**
 * The gadgets console `consoleId`'s published revision places on `screenIds`, at any depth, read
 * from the pages that publication froze (`getConsolePage(…, 'published')`: the nested page when one
 * was frozen, else the version 1 copy by conversion). That is what the kernel's placed-app fence
 * reads, so a builder is told about the same apps operators are refused. Null while not asked for
 * (`enabled` false), still loading, or after a read failed.
 */
export const usePublishedConsolePlacements = (overseer: RpcStub<Overseer> | undefined, consoleId: string,
    screenIds: readonly string[], enabled: boolean): WorkpieceId[] | null => {
  const [read, setRead] = useState<{ key: string; ids: WorkpieceId[] } | null>(null)
  const key = `${consoleId}\n${screenIds.join('\n')}`
  useEffect(() => {
    if (!overseer || !enabled) return
    let current = true
    Promise.all(screenIds.map(screenId => overseer.getConsolePage(consoleId, screenId, 'published'))).then(pages => {
      if (!current) return
      const ids = new Set(pages.flatMap(page => (page?.nodes ?? []).flatMap(node => {
        const match = node.nodeType === 'widget' && node.kind === 'inferos.gadget' ? CANVAS_GADGET_REF.exec(node.targetRef) : null
        return match ? [Number(match[1])] : []
      })))
      setRead({ key, ids: [...ids] })
    }, () => { if (current) setRead(null) })
    return () => { current = false }
    // `key` stands for `consoleId` and `screenIds`, whose array identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overseer, enabled, key])
  return enabled && read?.key === key ? read.ids : null
}
