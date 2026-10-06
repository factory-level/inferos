import { useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft } from '@phosphor-icons/react'
import type { WorkpieceId } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import WorkspaceOpenErrorPage from '../../components/WorkspaceOpenErrorPage'
import { OperatePublishReview } from '../../features/operate-publish/OperatePublishReview'
import { candidateOf, installsOf, messageOf, type Candidate } from '../../features/operate-publish/operatePublish'
import { useWorkspaceWorkpieces } from '../../hooks/useWorkspaceWorkpieces'
import ObserverConfigModal from '../../ObserverConfigModal'
import { useWorkspaceOpen } from '../../useWorkspaceOpen'

const ignore = () => {}

const Centered = ({ children }: { children: React.ReactNode }) =>
  <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-kumo-base px-6 text-center">{children}</div>

/**
 * The publication review of Build workspace `workspaceId`, with operate space `spaceId` under
 * review. Both workspaces are opened with the person's own access, and the space's installs are
 * read from its live workpiece subscription, so after a reconnect the review shows what the kernel
 * actually holds rather than what an action last reported.
 */
export const OperatePublishPage = ({ workspaceId, spaceId }: { workspaceId: string; spaceId: string | null }) => {
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()
  const source = useWorkspaceOpen({
    id: workspaceId, authenticatedApi, onMetadata: ignore, onShareKeyConsumed: ignore, onInvalidShareKey: ignore,
  })
  const target = useWorkspaceOpen({
    id: spaceId ?? undefined, authenticatedApi, onMetadata: ignore, onShareKeyConsumed: ignore, onInvalidShareKey: ignore,
  })
  const { workpieces } = useWorkspaceWorkpieces(spaceId ? target.overseer : null, spaceId ?? undefined)
  // undefined while loading; null when nothing was published from this workspace.
  const [candidate, setCandidate] = useState<Candidate | null | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [spaces, setSpaces] = useState<{ id: string; title: string }[]>([])

  const sourceStub = source.overseer?.stub
  useEffect(() => {
    if (!sourceStub) return
    let cancelled = false
    void (async () => {
      const [published] = await sourceStub.listBlueprints()
      // The signed-in read: a blueprint published only to this workspace is still reviewable here.
      const info = published ? await authenticatedApi.getBlueprintInfo(published.id) : null
      if (!cancelled) setCandidate(published && info ? candidateOf(published.id, info.metadata) : null)
    })().catch(caught => { if (!cancelled) setLoadError(messageOf(caught)) })
    return () => { cancelled = true }
  }, [sourceStub, authenticatedApi, reload])

  useEffect(() => {
    let cancelled = false
    authenticatedApi.listGadgets().then(list => {
      if (cancelled) return
      setSpaces(list.filter(item => item.id !== workspaceId && item.role !== 'use')
        .map(item => ({ id: item.id, title: item.title })))
    }).catch(caught => { if (!cancelled) setLoadError(messageOf(caught)) })
    return () => { cancelled = true }
  }, [authenticatedApi, workspaceId])

  const goToBuild = () => navigate({ to: '/workspace/$id', params: { id: workspaceId } })
  const selectSpace = (id: string) => navigate({
    to: '/workspace/$id/publish', params: { id: workspaceId }, search: { space: id }, replace: true,
  })

  if (source.error?.kind === 'open') {
    return <WorkspaceOpenErrorPage kind={source.error.failure} onGoToWorkspaces={() => navigate({ to: '/workspaces' })} onRetry={source.retry} />
  }
  const sourceMessage = source.error?.kind === 'message' ? source.error.message : loadError
  if (sourceMessage) return <Centered><p role="alert" className="max-w-lg text-sm text-kumo-danger">{sourceMessage}</p></Centered>
  const observerConfig = source.observerConfig ?? target.observerConfig
  const cancelObserverConfig = source.observerConfig ? source.cancelObserverConfig : target.cancelObserverConfig
  const observerModal = observerConfig && <ObserverConfigModal needs={observerConfig.needs} authenticatedApi={authenticatedApi}
    onConfirm={observerConfig.resolve} onCancel={cancelObserverConfig} />
  if (!source.metadata || !source.overseer || candidate === undefined) {
    return <Centered><p role="status" className="text-sm text-kumo-subtle">Loading the review…</p>{observerModal}</Centered>
  }
  // A use-only viewer sees the installed version where they use it, never authoring controls.
  if (source.metadata.role === 'use') {
    return <Centered><p className="text-sm text-kumo-subtle">You can use this workspace but not publish from it.</p>
      <Link to="/workspace/$id" params={{ id: workspaceId }} className="text-sm text-kumo-brand">Back to workspace</Link></Centered>
  }

  const spaceStub = target.overseer?.stub
  const space = spaceId && target.metadata && candidate ? {
    id: spaceId,
    title: target.metadata.title,
    testOnly: target.metadata.testOnly === true,
    stale: target.connectionLost || !spaceStub,
    installs: installsOf(workpieces.values(), candidate.blueprintId),
  } : null
  const requireSpace = () => {
    if (!spaceStub || !candidate) throw new Error('The space is not open.')
    return { stub: spaceStub, candidate }
  }

  return <div className="min-h-full bg-kumo-base">
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 pb-16 pt-6">
      <Link to="/workspace/$id" params={{ id: workspaceId }} className="flex items-center gap-2 text-sm text-kumo-subtle hover:text-kumo-default">
        <ArrowLeft size={16} aria-hidden /><span className="truncate">{source.metadata.title}</span>
      </Link>
      <h1 className="m-0 text-xl font-semibold text-kumo-default">Publish to Operate</h1>
      {spaceId && target.error && <p role="alert" className="m-0 text-sm text-kumo-danger">
        The space could not be opened with your access. Choose another, or ask its owner for build access.
      </p>}
      <OperatePublishReview key={candidate?.version ?? 'none'}
        sourceKind={source.metadata.kind ?? 'app'} candidate={candidate} onBackToBuild={goToBuild}
        onPublish={async dataContract => {
          if (!candidate) return
          await source.overseer!.stub.updateBlueprint(candidate.blueprintId,
              dataContract === undefined ? { updateCode: true } : { updateCode: true, dataContract })
          setReload(value => value + 1)
        }}
        spaces={spaces} space={space} onSelectSpace={selectSpace}
        onInstall={async requestKey => {
          const { stub, candidate: version } = requireSpace()
          await stub.installBlueprint(version.blueprintId, {},
              { version: version.version, kind: version.kind, requestKey })
        }}
        installWithBindingsHref={candidate && candidate.bindings.length > 0 && spaceId
          ? `/blueprint/${candidate.blueprintId}?space=${spaceId}` : null}
        onUpgrade={async (gadgetId: WorkpieceId, version: number) => {
          await requireSpace().stub.upgradeInstall(version, gadgetId)
        }}
        onSetTestOnly={async testOnly => { await requireSpace().stub.setTestOnly(testOnly) }} />
      {observerModal}
    </div>
  </div>
}
