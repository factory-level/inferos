// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PaneTab } from './PaneTab'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it.each(['Code', 'Connections'] as const)('activates %s without activating Delete chat', async label => {
  const onSelect = vi.fn<(selected: string) => void>()
  const onDeleteChat = vi.fn<() => void>()

  await act(async () => root.render(
    <div>
      <PaneTab active={false} label={label} onClick={() => onSelect(label)} />
      <button type="button" aria-label="Delete chat" onClick={onDeleteChat}>Delete chat</button>
    </div>,
  ))

  await act(async () => {
    container.querySelector<HTMLButtonElement>(`button:not([aria-label])`)!.click()
  })

  expect(onSelect).toHaveBeenCalledExactlyOnceWith(label)
  expect(onDeleteChat).not.toHaveBeenCalled()
})
