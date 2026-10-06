import { describe, expect, it } from 'vitest'
import type { BlueprintInstall, WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { candidateOf, installsOf, publicationFailure, upgradeBlock, type Candidate } from './operatePublish'

const candidate: Candidate = { blueprintId: 'bp', title: 'Counter', version: 3, kind: 'app', dataContract: 1, bindings: [] }
const installed = (version: number, extra: Partial<BlueprintInstall> = {}): BlueprintInstall =>
  ({ blueprintId: 'bp', version, kind: 'app', dataContract: 1, ...extra })

describe('upgradeBlock', () => {
  it('offers an upgrade only between equal declared contracts of the same kind', () => {
    expect(upgradeBlock(installed(2), candidate)).toBeNull()
    expect(upgradeBlock(installed(3), candidate)).toBe('current')
    expect(upgradeBlock(installed(2, { kind: 'widget' }), candidate)).toBe('wrongKind')
    expect(upgradeBlock(installed(2, { dataContract: 2 }), candidate)).toBe('needsMigration')
    expect(upgradeBlock(installed(2, { dataContract: undefined }), candidate)).toBe('unknownContract')
    expect(upgradeBlock(installed(2), { ...candidate, dataContract: undefined })).toBe('unknownContract')
  })
})

describe('installsOf', () => {
  it('finds the space gadgets installed from the blueprint, ignoring others', () => {
    const workpieces: WorkpieceSummary[] = [
      { id: 5, type: 'gadget', title: 'Second', installedFrom: installed(1) },
      { id: 2, type: 'gadget', title: 'Own code' },
      { id: 3, type: 'gadget', title: 'Other', installedFrom: { ...installed(1), blueprintId: 'other' } },
      { id: 1, type: 'gadget', title: 'First', installedFrom: installed(2) },
    ]
    expect(installsOf(workpieces, 'bp').map(install => install.gadgetId)).toEqual([1, 5])
  })
})

describe('candidateOf', () => {
  it('treats a missing kind as an app and a missing contract as unknown', () => {
    expect(candidateOf('bp', { title: 'T', description: '', author: { type: 'user', id: 'u', name: 'U' },
      created: new Date(), version: 1, lastUpdated: new Date(), bindings: { DATA: { type: 'aiModel', title: 'Model', description: '' } } }))
      .toEqual({ blueprintId: 'bp', title: 'T', version: 1, kind: 'app', bindings: ['DATA'] })
  })
})

describe('publicationFailure', () => {
  it('classifies the kernel refusals into the review states', () => {
    expect(publicationFailure('Blueprint version 3 needs migration: it declares data contract 2, and the installed version 2 declares 1.')).toBe('needsMigration')
    expect(publicationFailure('Blueprint version 4 declares no data contract, so its data\'s compatibility is unknown; the install cannot be upgraded to it.')).toBe('unknownContract')
    expect(publicationFailure('This workspace is not test-only, so it cannot install mock dependencies: the binding "DATA" names mock data (x).')).toBe('mockDependency')
    expect(publicationFailure('Blueprint version 1 is a widget, not a app.')).toBe('wrongKind')
    expect(publicationFailure('Blueprint version 2 needs the binding "EXTRA", which this install does not have. Bind it, then upgrade.')).toBe('missingBinding')
    expect(publicationFailure('No such account.')).toBe('revokedBinding')
    expect(publicationFailure('The workspace changed during the upgrade; please retry.')).toBe('changed')
    expect(publicationFailure('Blueprint version 9 not found.')).toBe('notFound')
    expect(publicationFailure('Unauthorized: this collaborator only has permission to use the gadget\'s UI.')).toBe('notAllowed')
    expect(publicationFailure('Network down')).toBe('other')
  })
})
