import { useEffect, useState } from 'react'
import { RpcTarget, type RpcStub } from 'capnweb'
import type { OperateSession, OperateSubjectParticipant, PresenceSubscriber } from '@gadgets/workshop-shared/api'
import type { OperateBoardView } from '@gadgets/workshop-shared/operate-session'

class Roster extends RpcTarget implements PresenceSubscriber<OperateSubjectParticipant> {
  readonly #participants = new Map<string, OperateSubjectParticipant>()
  constructor(private onChange: (participants: OperateSubjectParticipant[]) => void) { super() }
  init(participants: OperateSubjectParticipant[]) {
    this.#participants.clear()
    for (const participant of participants) this.#participants.set(participant.key, participant)
    this.onChange([...this.#participants.values()])
  }
  add(participant: OperateSubjectParticipant) {
    this.#participants.set(participant.key, participant)
    this.onChange([...this.#participants.values()])
  }
  remove(key: string) {
    this.#participants.delete(key)
    this.onChange([...this.#participants.values()])
  }
}

/**
 * Who has the session's board open, the caller included, while this tab shows it. Joining is what
 * makes this person visible to the others, so the subscription follows the board and issue shown
 * and ends with them. Empty until the roster arrives, and when the kernel refuses (no reach).
 * Callers key their component by the board so a new subject never starts from the last roster.
 */
export const useSubjectPresence = (session: { stub: RpcStub<OperateSession> } | null,
  board: OperateBoardView): OperateSubjectParticipant[] => {
  const [participants, setParticipants] = useState<OperateSubjectParticipant[]>([])
  useEffect(() => {
    if (!session) return
    let cancelled = false
    let subscription: RpcStub<{}> | undefined
    const roster = new Roster(next => { if (!cancelled) setParticipants(next) })
    session.stub.subscribeToSubjectPresence(roster as unknown as RpcStub<PresenceSubscriber<OperateSubjectParticipant>>)
      .then(resolved => {
        if (cancelled) resolved[Symbol.dispose]()
        else subscription = resolved
      })
      .catch(caught => { if (!cancelled) console.error('Could not join the board\'s presence:', caught) })
    return () => {
      cancelled = true
      subscription?.[Symbol.dispose]()
    }
  }, [session, board.workspaceId, board.boardRef, board.issueId])
  return participants
}
