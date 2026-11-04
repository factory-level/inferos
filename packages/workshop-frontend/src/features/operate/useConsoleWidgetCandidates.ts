import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { GadgetSummary, Overseer } from '@gadgets/workshop-shared/api'
import type { ConsoleWidgetCandidate } from '@gadgets/workshop-shared/operate-console'
import type { WidgetCandidates } from './ConsoleWidgetRegistry'

type Answer = { state: 'loading' } | { state: 'error' } | { state: 'ready'; list: ConsoleWidgetCandidate[] }

/**
 * The kernel's description of the workspace's widget installs (`listConsoleWidgetCandidates`),
 * titled from `installs`, the workspace's widget installs as its workpiece list shows them. It is
 * asked again whenever one of them is added, removed, moves to another commit or another version,
 * so what the registry editor offers follows the installs.
 */
export const useConsoleWidgetCandidates = (overseer: { stub: RpcStub<Overseer> } | null,
    installs: GadgetSummary[]): WidgetCandidates => {
  const [answer, setAnswer] = useState<Answer>({ state: 'loading' })
  const key = installs.map(install => `${install.id}:${install.commitId ?? ''}:${install.installedFrom?.version ?? ''}`).join(',')
  useEffect(() => {
    if (!overseer) return
    let current = true
    setAnswer({ state: 'loading' })
    Promise.resolve().then(() => overseer.stub.listConsoleWidgetCandidates())
      .then(list => { if (current) setAnswer({ state: 'ready', list }) })
      .catch((err: unknown) => {
        console.error('Failed to describe widget installs:', err)
        if (current) setAnswer({ state: 'error' })
      })
    return () => { current = false }
  }, [overseer, key])
  if (answer.state !== 'ready') return answer
  const titles = new Map(installs.map(install => [install.id, install.title]))
  return { state: 'ready', list: answer.list.map(candidate =>
    ({ ...candidate, title: titles.get(candidate.gadgetId) ?? `Gadget ${candidate.gadgetId}` })) }
}
