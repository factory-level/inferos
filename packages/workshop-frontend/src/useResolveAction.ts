import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import { SHARED_CONFIGURATION_REFUSED, type ActionState, type Overseer } from '@gadgets/workshop-shared/api'

type ActionDecision = 'approve' | 'deny'

/** What a failed approve says instead of what it threw (FAC-119): the card says why, in the decision's words. */
export const APPROVE_FAILED_TEXT = "It wasn't applied. The action shows why."

/**
 * A failed decision's toast text. An approve's thrown message may be the provider's own words (the
 * kernel rethrows a failed apply's message), so it is never shown: the action's card says why, in
 * the decision's words. The kernel's own refusal that the person may not decide is shown as is, as
 * is any rejection's, which reaches no provider.
 */
export const resolveFailureText = (decision: ActionDecision, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  if (decision === 'deny') return message
  return message === SHARED_CONFIGURATION_REFUSED || message.endsWith(`: ${SHARED_CONFIGURATION_REFUSED}`)
    ? SHARED_CONFIGURATION_REFUSED : APPROVE_FAILED_TEXT
}

export function useResolveAction(
  overseer: RpcStub<Overseer>,
  setProcessing: Dispatch<SetStateAction<Set<number>>>,
  onResolved?: (actionId: number, state: Extract<ActionState, 'approved' | 'rejected'>) => void,
) {
  const toasts = useKumoToastManager()
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved

  return useCallback(async (actionId: number, decision: ActionDecision) => {
    setProcessing(previous => new Set(previous).add(actionId))
    try {
      if (decision === 'approve') await overseer.approveAction(actionId)
      else await overseer.rejectAction(actionId)
      onResolvedRef.current?.(actionId, decision === 'approve' ? 'approved' : 'rejected')
    } catch (error) {
      console.error(`Failed to ${decision} action:`, error)
      toasts.add({ title: `Failed to ${decision} action`, description: resolveFailureText(decision, error), variant: 'error' })
    } finally {
      setProcessing(previous => {
        const next = new Set(previous)
        next.delete(actionId)
        return next
      })
    }
  }, [overseer, setProcessing, toasts])
}
