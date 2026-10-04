import { useEffect, useRef } from 'react'
import type { OperateBoardView, OperateEvent } from '@gadgets/workshop-shared/operate-session'

/** The route search params that mirror the session's shown board and issue. */
export type BoardSearch = { board?: string; boardWorkspace?: string; issue?: string }

const keyOf = (boardRef?: string | null, workspaceId?: string | null, issueId?: string | null) =>
  boardRef ? `${workspaceId ?? ''} ${boardRef} ${issueId ?? ''}` : ''

/**
 * Mirrors the session's shown board and issue into the URL, so the browser's Back and Forward move
 * through them like the in-app Back. The session stays the truth: a change from this tab, another
 * tab or the agent is written to the URL (a new history entry when something opened, a replacement
 * when something closed), and a browser move is sent to the session as the event it stands for.
 * Forward to a board goes through `openBoard`, which the kernel checks against the connection like
 * any other; if the session refuses a browser move, the URL is put back to what the session shows.
 */
export const useBoardHistory = (board: OperateBoardView | null, search: BoardSearch,
    onNavigate: (search: BoardSearch, replace: boolean) => void, onEvent: (event: OperateEvent) => Promise<unknown>) => {
  const url = keyOf(search.board, search.boardWorkspace, search.issue)
  const page = keyOf(board?.boardRef, board?.workspaceId, board?.issueId)
  const lastUrl = useRef(url)
  // Runs only when the URL or the session's board changes; the callbacks are fresh every render
  // and would otherwise repeat a navigation that is still in flight.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const urlMoved = lastUrl.current !== url
    lastUrl.current = url
    if (url === page) return
    const current: BoardSearch = { board: board?.boardRef, boardWorkspace: board?.workspaceId, issue: board?.issueId ?? undefined }
    if (urlMoved) {
      const event: OperateEvent | null = !search.board ? board && { type: 'closeBoard' }
        : board && search.board === board.boardRef && search.boardWorkspace === board.workspaceId
          ? search.issue ? { type: 'openIssue', issueId: search.issue } : { type: 'closeIssue' }
        : search.boardWorkspace ? { type: 'openBoard', board: { workspaceId: search.boardWorkspace, boardRef: search.board } }
        : null
      const moved = event ? onEvent(event) : Promise.reject(new Error('The URL names no board the session can open.'))
      moved.catch(() => onNavigate(current, true))
      return
    }
    const opened = !!board && (search.board !== board.boardRef || (!!board.issueId && search.issue !== board.issueId))
    onNavigate(current, !opened)
  }, [url, page])
}
