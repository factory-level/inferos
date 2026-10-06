import { useState } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import type { ObserverAccountChoice, ObserverBindingNeed, ObserverConfigCallback } from '@gadgets/workshop-shared/api'

/** An open request from the Workshop to choose accounts for a workspace's connections. */
export type ObserverPrompt = {
  needs: ObserverBindingNeed[]
  resolve: (choices: ObserverAccountChoice[]) => void
  reject: (error: unknown) => void
}

/** The message a prompt the person cancelled is rejected with. */
export const OBSERVER_PROMPT_CANCELLED = 'You must choose connected accounts for the services this workspace uses.'

/**
 * The account-verification prompt for a one-off `openGadget` (pages that keep a workspace open use
 * `useWorkspaceOpen`, which has its own). `newCallback()` mints the callback to pass to one open;
 * while the Workshop asks, `prompt` is set for an `ObserverConfigModal`. Dispose each callback
 * after its open.
 */
export const useObserverPrompt = () => {
  const [prompt, setPrompt] = useState<ObserverPrompt | null>(null)
  const newCallback = () => new RpcStub<ObserverConfigCallback>(new (class extends RpcTarget implements ObserverConfigCallback {
    configure(needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]> {
      return new Promise<ObserverAccountChoice[]>((resolve, reject) => setPrompt({
        needs,
        resolve: choices => { setPrompt(null); resolve(choices) },
        reject: error => { setPrompt(null); reject(error) },
      }))
    }
  })())
  return { prompt, newCallback, cancel: () => prompt?.reject(new Error(OBSERVER_PROMPT_CANCELLED)) }
}
