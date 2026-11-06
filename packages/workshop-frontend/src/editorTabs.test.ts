import { expect, it } from 'vitest'
import type { WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { rightTabs } from './editorTabs'

const gadget = { type: 'gadget', id: 1, title: 'Status' } as WorkpieceSummary
const worktree = { type: 'worktree', id: 2, title: 'branch' } as WorkpieceSummary
const values = (tabs: ReturnType<typeof rightTabs>) => tabs.map(tab => tab.value)

it('keeps the editor\'s tabs unchanged while authored widgets are off', () => {
  expect(rightTabs(gadget, 'app', false)).toEqual([
    { value: 'app', label: 'App' }, { value: 'code', label: 'Code' }, { value: 'connections', label: 'Connections' }])
  expect(values(rightTabs(worktree, 'app', false))).toEqual(['code'])
  expect(rightTabs(gadget, 'triggers', false)[0]).toEqual({ value: 'app', label: 'Triggers' })
})

it('adds the build preview after the app tab for a gadget once authored widgets are on', () => {
  expect(rightTabs(gadget, 'app', true)).toEqual([
    { value: 'app', label: 'App' }, { value: 'preview', label: 'Build preview' },
    { value: 'code', label: 'Code' }, { value: 'connections', label: 'Connections' }])
})

it('offers no build preview where there is no widget UI to build', () => {
  expect(values(rightTabs(worktree, 'app', true))).toEqual(['code'])
  expect(values(rightTabs(gadget, 'triggers', true))).toEqual(['app', 'code', 'connections'])
})
