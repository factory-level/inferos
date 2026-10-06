import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Select } from '@cloudflare/kumo'
import { TestSpaceBadge } from '../../components/TestSpaceBadge'
import type { WorkpieceId, WorkspaceKind } from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopInput } from '../../components/WorkshopControls'
import { WorkspaceKindChip } from '../workspace-kind/WorkspaceKindChip'
import {
  FAILURE_ADVICE, messageOf, publicationFailure, upgradeBlock, upgradeBlockText,
  type Candidate, type SpaceInstall,
} from './operatePublish'

/** The operate space under review, as its own subscription currently reports it. */
export type ReviewedSpace = {
  id: string
  title: string
  /** Marked test-only: may hold installs that depend on mock data or models. */
  testOnly: boolean
  /** The connection to it dropped: what is shown may be out of date until it reconnects. */
  stale: boolean
  installs: SpaceInstall[]
}

type Props = {
  /** The source workspace's kind, which the next published version takes. */
  sourceKind: WorkspaceKind
  /** The blueprint's current published version, or null when nothing was published. */
  candidate: Candidate | null
  onBackToBuild: () => void
  onPublish: (dataContract: number | undefined) => Promise<void>
  /** Workspaces the person may install into. */
  spaces: { id: string; title: string }[]
  space: ReviewedSpace | null
  onSelectSpace: (id: string) => void
  /**
   * Installs the candidate into the space. `requestKey` names the person's intent to install this
   * version there: it is the same on a retry, so a request that reached the kernel before the
   * connection dropped is not installed twice (see `SpaceInstallOptions.requestKey`).
   */
  onInstall: (requestKey: string) => Promise<void>
  /** Where to choose connections for a candidate that needs some, before installing. */
  installWithBindingsHref: string | null
  onUpgrade: (gadgetId: WorkpieceId, version: number) => Promise<void>
  /** Marks the space test-only (it then accepts mock dependencies) or normal again. */
  onSetTestOnly: (testOnly: boolean) => Promise<void>
}

type Failure = { action: string; message: string }

const Section = ({ title, children }: { title: string; children: ReactNode }) => {
  const id = useId()
  return <section aria-labelledby={id} className="flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-elevated p-4">
    <h2 id={id} className="m-0 text-sm font-semibold text-kumo-default">{title}</h2>
    {children}
  </section>
}

const contractText = (contract: number | undefined) =>
  contract === undefined ? 'not declared (unknown)' : String(contract)

/**
 * The Build review of what this workspace publishes to Operate: the published version, an explicit
 * Publish of the next one with its data contract, and, for a chosen space, explicit Install and
 * per-install Upgrade actions. One action runs at a time; a refusal is shown with what it means, and
 * the space's own subscription, not the action's result, is what the installs list shows.
 */
export const OperatePublishReview = ({
  sourceKind, candidate, onBackToBuild, onPublish, spaces, space, onSelectSpace, onInstall,
  installWithBindingsHref, onUpgrade, onSetTestOnly,
}: Props) => {
  const [pending, setPending] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [contract, setContract] = useState(candidate?.dataContract?.toString() ?? '')
  const failureRef = useRef<HTMLDivElement>(null)
  const contractId = useId()
  const installIntent = useRef<{ spaceId: string; version: number; key: string } | null>(null)
  // Move focus to a new failure's explanation, so a keyboard or screen-reader user lands on it.
  useEffect(() => { if (failure) failureRef.current?.focus() }, [failure])

  const run = async (action: string, operation: () => Promise<void>) => {
    if (pending !== null) return
    setPending(action)
    setFailure(null)
    try {
      await operation()
    } catch (caught) {
      setFailure({ action, message: messageOf(caught) })
    } finally {
      setPending(null)
    }
  }

  if (!candidate) {
    return <Section title="Nothing to review">
      <p className="m-0 text-sm text-kumo-subtle">
        No version of this workspace has been published yet, so there is nothing to install. Publish it from Build first.
      </p>
      <div><WorkshopButton tone="primary" onClick={onBackToBuild}>Back to Build</WorkshopButton></div>
    </Section>
  }

  const trimmed = contract.trim()
  const parsedContract = trimmed === '' ? undefined : Number(trimmed)
  const contractInvalid = parsedContract !== undefined && !(Number.isSafeInteger(parsedContract) && parsedContract >= 0)
  const busy = pending !== null
  const blocked = busy || !space || space.stale
  const failureKind = failure ? publicationFailure(failure.message) : null

  return <div className="flex flex-col gap-4">
    {failure && failureKind && <div ref={failureRef} tabIndex={-1} role="alert"
      className="rounded-lg border border-kumo-danger p-3 text-sm text-kumo-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
      <p className="m-0 font-medium">{failure.action} failed: {failure.message}</p>
      <p className="m-0 mt-1 text-kumo-default">{FAILURE_ADVICE[failureKind]}</p>
    </div>}

    <Section title="Published version">
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-kumo-subtle">Blueprint</dt><dd className="m-0">{candidate.title}</dd>
        <dt className="text-kumo-subtle">Version</dt><dd className="m-0">{candidate.version}</dd>
        <dt className="text-kumo-subtle">Kind</dt><dd className="m-0"><WorkspaceKindChip kind={candidate.kind} /></dd>
        <dt className="text-kumo-subtle">Data contract</dt><dd className="m-0">{contractText(candidate.dataContract)}</dd>
        <dt className="text-kumo-subtle">Connections</dt>
        <dd className="m-0">{candidate.bindings.length === 0 ? 'None' : candidate.bindings.join(', ')}</dd>
      </dl>
    </Section>

    <Section title={`Publish version ${candidate.version + 1}`}>
      <p className="m-0 text-sm text-kumo-subtle">
        Snapshots this workspace's committed code as a new version. Installs keep running the version they have until someone upgrades them.
      </p>
      {sourceKind !== candidate.kind && <p className="m-0 text-sm text-kumo-warning">
        This workspace is now a {sourceKind}, so the new version will be one too. Installs of the {candidate.kind} cannot upgrade to it.
      </p>}
      <div className="flex flex-col gap-1">
        <label htmlFor={contractId} className="text-sm font-medium text-kumo-default">Data contract</label>
        <WorkshopInput id={contractId} inputMode="numeric" value={contract} aria-invalid={contractInvalid}
          aria-describedby={`${contractId}-help`} onChange={event => setContract(event.target.value)} />
        <p id={`${contractId}-help`} className="m-0 text-xs text-kumo-subtle">
          {contractInvalid ? 'Enter a whole number of 0 or more, or leave it empty.'
            : 'Keep the number while stored data stays compatible; change it when it does not. Empty means unknown, and installs cannot upgrade to it.'}
        </p>
      </div>
      <div>
        <WorkshopButton tone="primary" disabled={busy || contractInvalid}
          onClick={() => run('Publish', () => onPublish(parsedContract))}>
          {pending === 'Publish' ? 'Publishing…' : `Publish version ${candidate.version + 1}`}
        </WorkshopButton>
      </div>
    </Section>

    <Section title="Install into an operate space">
      {spaces.length === 0
        ? <p className="m-0 text-sm text-kumo-subtle">You have build access to no other workspace to install into.</p>
        : <Select label="Space" value={space?.id ?? null} placeholder="Choose a space" disabled={busy}
            onValueChange={value => { if (typeof value === 'string') onSelectSpace(value) }}>
            {spaces.map(item => <Select.Option key={item.id} value={item.id}>{item.title || 'Untitled workspace'}</Select.Option>)}
          </Select>}
      {space && <>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-kumo-default">{space.title || 'Untitled workspace'}</span>
          {space.testOnly && <TestSpaceBadge />}
          {space.stale && <span role="status" className="text-kumo-subtle">Reconnecting. Actions wait until the space is current again.</span>}
          <WorkshopButton className="ml-auto" disabled={blocked}
            onClick={() => run(space.testOnly ? 'Mark as a normal space' : 'Mark as a test space', () => onSetTestOnly(!space.testOnly))}>
            {space.testOnly ? 'Mark as a normal space' : 'Mark as a test space'}
          </WorkshopButton>
        </div>
        {space.testOnly && <p className="m-0 text-sm text-kumo-subtle">
          A test space accepts installs that use mock data or mock models. It stays a test space while it holds any.
        </p>}
        {space.installs.length === 0
          ? <p className="m-0 text-sm text-kumo-subtle">This space has no install of {candidate.title}.</p>
          : <ul aria-label="Installs in this space" className="m-0 flex list-none flex-col gap-2 p-0">
              {space.installs.map(install => {
                const block = upgradeBlock(install.installedFrom, candidate)
                const action = `Upgrade ${install.title}`
                return <li key={install.gadgetId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-kumo-line p-2 text-sm">
                  <div className="flex flex-col">
                    <span className="font-medium">{install.title}</span>
                    <span className="text-kumo-subtle">
                      Version {install.installedFrom.version}, data contract {contractText(install.installedFrom.dataContract)}
                      {install.installedFrom.mockDependencies?.length ? `; mock: ${install.installedFrom.mockDependencies.join(', ')}` : ''}
                    </span>
                    {block && <span className="text-kumo-subtle">{upgradeBlockText(block, install.installedFrom, candidate)}</span>}
                  </div>
                  {!block && <WorkshopButton disabled={blocked} aria-label={`Upgrade ${install.title} from version ${install.installedFrom.version} to ${candidate.version}`}
                    onClick={() => run(action, () => onUpgrade(install.gadgetId, candidate.version))}>
                    {pending === action ? 'Upgrading…' : `Upgrade to version ${candidate.version}`}
                  </WorkshopButton>}
                </li>
              })}
            </ul>}
        <div className="flex flex-wrap items-center gap-2">
          {installWithBindingsHref
            ? <a href={blocked ? undefined : installWithBindingsHref} aria-disabled={blocked}
                className="text-sm font-medium text-kumo-brand aria-disabled:pointer-events-none aria-disabled:opacity-50">
                Choose connections and install version {candidate.version}
              </a>
            : <WorkshopButton tone="primary" disabled={blocked}
                onClick={() => run('Install', async () => {
                  // One key per intent: kept for a retry of the same version into the same space,
                  // and dropped once it installed, so the next Install is a new install.
                  const intent = installIntent.current
                  const key = intent && intent.spaceId === space.id && intent.version === candidate.version
                    ? intent.key : crypto.randomUUID()
                  installIntent.current = { spaceId: space.id, version: candidate.version, key }
                  await onInstall(key)
                  installIntent.current = null
                })}>
                {pending === 'Install' ? 'Installing…' : `Install version ${candidate.version}`}
              </WorkshopButton>}
        </div>
      </>}
    </Section>
  </div>
}
