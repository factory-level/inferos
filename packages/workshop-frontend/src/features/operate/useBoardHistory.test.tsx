// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OperateBoardView, OperateEvent } from '@gadgets/workshop-shared/operate-session'
import { useBoardHistory, type BoardSearch } from './useBoardHistory'

const ENG = 'inferops://acme.operations/project/board/ENG'
const WEB = 'inferops://acme.operations/project/board/WEB'
const shown = (boardRef: string, issueId: string | null = null): OperateBoardView => ({ workspaceId: 'ws', boardRef, issueId })

const navigate = vi.fn<(search: BoardSearch, replace: boolean) => void>()
const onEvent = vi.fn<(event: OperateEvent) => Promise<unknown>>(async () => {})
const Harness = ({ board, search }: { board: OperateBoardView | null; search: BoardSearch }) => {
  useBoardHistory(board, search, navigate, onEvent)
  return null
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); root = createRoot(container)
  navigate.mockClear(); onEvent.mockClear()
})
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals() })
const settle = () => act(async () => { await Promise.resolve() })
const render = (board: OperateBoardView | null, search: BoardSearch) => act(() => root.render(<Harness board={board} search={search} />))

it('writes an opened board and issue as new history entries, and a close as a replacement', () => {
  render(null, {})
  expect(navigate).not.toHaveBeenCalled()
  render(shown(ENG), {})
  expect(navigate).toHaveBeenLastCalledWith({ board: ENG, boardWorkspace: 'ws', issue: undefined }, false)
  render(shown(ENG), { board: ENG, boardWorkspace: 'ws' })
  render(shown(ENG, 'i1'), { board: ENG, boardWorkspace: 'ws' })
  expect(navigate).toHaveBeenLastCalledWith({ board: ENG, boardWorkspace: 'ws', issue: 'i1' }, false)
  render(shown(ENG, 'i1'), { board: ENG, boardWorkspace: 'ws', issue: 'i1' })
  // Closed in another tab or by the agent: mirrored without a new entry.
  render(null, { board: ENG, boardWorkspace: 'ws', issue: 'i1' })
  expect(navigate).toHaveBeenLastCalledWith({ board: undefined, boardWorkspace: undefined, issue: undefined }, true)
  expect(onEvent).not.toHaveBeenCalled()
})

it('turns the browser\'s Back and Forward into session events', () => {
  render(shown(ENG, 'i1'), { board: ENG, boardWorkspace: 'ws', issue: 'i1' })
  // Back from the issue: the board stays, the issue closes.
  render(shown(ENG, 'i1'), { board: ENG, boardWorkspace: 'ws' })
  expect(onEvent).toHaveBeenLastCalledWith({ type: 'closeIssue' })
  render(shown(ENG), { board: ENG, boardWorkspace: 'ws' })
  // Back from the board.
  render(shown(ENG), {})
  expect(onEvent).toHaveBeenLastCalledWith({ type: 'closeBoard' })
  render(null, {})
  // Forward to the board goes through the kernel-checked openBoard, then to the issue.
  render(null, { board: WEB, boardWorkspace: 'ws' })
  expect(onEvent).toHaveBeenLastCalledWith({ type: 'openBoard', board: { workspaceId: 'ws', boardRef: WEB } })
  render(shown(WEB), { board: WEB, boardWorkspace: 'ws' })
  render(shown(WEB), { board: WEB, boardWorkspace: 'ws', issue: 'i2' })
  expect(onEvent).toHaveBeenLastCalledWith({ type: 'openIssue', issueId: 'i2' })
  expect(navigate).not.toHaveBeenCalled()
})

it('puts the URL back to the session when the session refuses what the URL asked for', async () => {
  render(shown(ENG), { board: ENG, boardWorkspace: 'ws' })
  onEvent.mockRejectedValueOnce(new Error('OPERATE_SESSION_BOARD_UNAVAILABLE'))
  render(shown(ENG), { board: WEB, boardWorkspace: 'ws' })
  expect(onEvent).toHaveBeenLastCalledWith({ type: 'openBoard', board: { workspaceId: 'ws', boardRef: WEB } })
  await settle()
  expect(navigate).toHaveBeenLastCalledWith({ board: ENG, boardWorkspace: 'ws', issue: undefined }, true)
  // A URL naming a board with no workspace cannot be opened and is put back at once.
  navigate.mockClear()
  render(shown(ENG), { board: WEB })
  await settle()
  expect(navigate).toHaveBeenLastCalledWith({ board: ENG, boardWorkspace: 'ws', issue: undefined }, true)
})
