// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GadgetMetadata, WorkspaceKind } from '@gadgets/workshop-shared/api'
import { DEFAULT_UI_FEATURE_FLAGS } from '@gadgets/workshop-shared/feature-flags'
import { WorkspaceKindHeader } from './WorkspaceKindHeader'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

// jsdom has no PointerEvent, which Kumo's radio dispatches on click.
if (!('PointerEvent' in window)) {
  Object.defineProperty(window, 'PointerEvent', { value: class extends MouseEvent {} })
}

const flags = vi.hoisted(() => ({ operateMode: true }))

vi.mock('../../FeatureFlagsContext', () => ({
  useUiFeatureFlags: () => ({
    flags: { ...DEFAULT_UI_FEATURE_FLAGS, 'operate-mode': flags.operateMode },
    loading: false,
  }),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  flags.operateMode = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

function render(
  metadata: Pick<GadgetMetadata, 'kind' | 'role'>,
  options: {
    onSetKind?: (kind: WorkspaceKind) => Promise<void>
    appView?: boolean
    onAppViewChange?: (appView: boolean) => void
  } = {},
) {
  act(() => {
    root.render(
      <WorkspaceKindHeader
        metadata={metadata}
        onSetKind={options.onSetKind ?? (async () => {})}
        appView={options.appView ?? false}
        onAppViewChange={options.onAppViewChange ?? (() => {})}
      />,
    )
  })
}

const kindButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label^="Workspace kind"]')

function buttonByText(text: string) {
  return [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text) ?? null
}

function radioFor(label: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="radio"]')]
    .find(r => r.closest('label')?.textContent?.includes(label)) ?? null
}

async function openSwitch() {
  await act(async () => { kindButton()!.click() })
}

describe('WorkspaceKindHeader', () => {
  it('renders nothing when operate-mode is off', () => {
    flags.operateMode = false
    render({ kind: 'app', role: 'build' })
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing for a use-role viewer', () => {
    render({ kind: 'app', role: 'use' })
    expect(container.innerHTML).toBe('')
  })

  it('reads an absent kind as App', () => {
    render({ role: 'build' })
    expect(kindButton()?.getAttribute('aria-label')).toContain('App')
  })

  it('offers the Chat ↔ App toggle only for an app', () => {
    const onAppViewChange = vi.fn<(appView: boolean) => void>()
    render({ kind: 'app', role: 'build' }, { onAppViewChange })
    const group = container.querySelector('[role="group"][aria-label="Workspace view"]')
    expect(group).not.toBeNull()
    const segment = (text: string) =>
      [...group!.querySelectorAll('button')].find(b => b.textContent === text)!
    expect(segment('Chat').getAttribute('aria-pressed')).toBe('true')
    expect(segment('App').getAttribute('aria-pressed')).toBe('false')
    act(() => segment('App').click())
    expect(onAppViewChange).toHaveBeenCalledWith(true)

    render({ kind: 'widget', role: 'build' })
    expect(container.querySelector('[aria-label="Workspace view"]')).toBeNull()
    render({ kind: 'workflow', role: 'build' })
    expect(container.querySelector('[aria-label="Workspace view"]')).toBeNull()
  })

  it('switches kind only after the user confirms the chosen kind', async () => {
    const onSetKind = vi.fn<(kind: WorkspaceKind) => Promise<void>>(async () => {})
    render({ kind: 'app', role: 'build' }, { onSetKind })
    await openSwitch()

    expect(buttonByText('Switch kind')?.disabled).toBe(true)
    await act(async () => { radioFor('Workflow')!.click() })
    expect(document.body.textContent).toContain('hides the app view')
    expect(onSetKind).not.toHaveBeenCalled()

    await act(async () => { buttonByText('Switch to Workflow')!.click() })
    expect(onSetKind).toHaveBeenCalledWith('workflow')
  })

  it('does not switch kind when cancelled', async () => {
    const onSetKind = vi.fn<(kind: WorkspaceKind) => Promise<void>>(async () => {})
    render({ kind: 'app', role: 'build' }, { onSetKind })
    await openSwitch()
    await act(async () => { radioFor('Widget')!.click() })
    await act(async () => { buttonByText('Cancel')!.click() })
    expect(onSetKind).not.toHaveBeenCalled()
  })

  it('shows an error and stays open when the switch fails', async () => {
    const onSetKind = vi.fn<(kind: WorkspaceKind) => Promise<void>>(async () => { throw new Error('denied') })
    render({ kind: 'app', role: 'build' }, { onSetKind })
    await openSwitch()
    await act(async () => { radioFor('Widget')!.click() })
    await act(async () => { buttonByText('Switch to Widget')!.click() })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't switch to Widget")
    expect(buttonByText('Switch to Widget')).not.toBeNull()
  })
})
