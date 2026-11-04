import { useEffect, useState } from 'react'
import { Dialog, Select } from '@cloudflare/kumo'
import { Warning, X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type {
  AgentSpawnerBehaviour,
  AgentSpawnerConfig,
  AiChatAuthorInfo,
  AuthenticatedApi,
  Overseer,
  WorkpieceId,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton } from '../components/WorkshopControls'
import { reportIssue } from '../errorReporting'
import { AgentBindingsField } from './AgentBindingsField'
import {
  AgentSpawnerConfigForm,
  rowsForAgentEnv,
  spawnerEnvFromRows,
  validateSpawnerEnv,
  type SpawnerEnvRow,
} from './AgentSpawnerConfigForm'
import { ConnectionConfigField } from './ConnectionConfigField'

/** An agent bound to the gadget: its binding name there and the agent's workpiece. */
export interface AgentBindingRef {
  name: string
  gatekeeperId: WorkpieceId
  title: string
}

export interface AgentSettingsModalProps {
  /** The agent being edited, or null when the modal is closed. */
  target: AgentBindingRef | null
  overseer: RpcStub<Overseer>
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  /** What the gadget can offer an agent's bindings: itself and its own bindings. */
  envCandidates: Omit<SpawnerEnvRow, 'enabled'>[]
  /** The gadget's other agents, offered as a starting point for this one's capabilities. */
  otherAgents: AgentBindingRef[]
  onClose: () => void
  onSaved: () => void
}

/**
 * Which of `targets` are agent `selfId` or reach it through agents' env, so offering them would let
 * the agent spawn itself (the server refuses that too). `readEnv` gives an agent's env, or null for
 * anything that isn't an agent; each workpiece is read at most once.
 */
export async function agentsReaching(
  selfId: WorkpieceId,
  targets: WorkpieceId[],
  readEnv: (id: WorkpieceId) => Promise<Record<string, WorkpieceId> | null>,
): Promise<Set<WorkpieceId>> {
  const envs = new Map<WorkpieceId, Promise<Record<string, WorkpieceId> | null>>()
  const envOf = (id: WorkpieceId) => {
    if (!envs.has(id)) envs.set(id, readEnv(id).catch(() => null))
    return envs.get(id)!
  }
  const reaches = async (start: WorkpieceId) => {
    const seen = new Set<WorkpieceId>()
    const queue = [start]
    while (queue.length) {
      const id = queue.pop()!
      if (id === selfId) return true
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(...Object.values((await envOf(id)) ?? {}))
    }
    return false
  }
  const reaching = new Set<WorkpieceId>()
  for (const target of targets) if (await reaches(target)) reaching.add(target)
  return reaching
}

const CREATOR_ONLY = "Only the person who created this agent can change its model, instructions and " +
  "capabilities: its agents run with that person's account and authority. You can change its name."

/**
 * Another agent's selection laid over this one's rows: what it reaches here is switched on under its
 * names and everything else off. Targets it reaches that this gadget can't offer are left out.
 */
export function rowsFromOtherAgent(rows: SpawnerEnvRow[], otherEnv: Record<string, WorkpieceId>): SpawnerEnvRow[] {
  const offered = new Map(Object.entries(otherEnv).map(([envName, envTarget]) => [envTarget, envName]))
  return rows.map((row) => {
    const name = offered.get(row.target)
    return name === undefined ? { ...row, enabled: false } : { ...row, enabled: true, name }
  })
}

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback

/**
 * Reopen a saved agent: its name, model and instructions save together, and what it can reach saves
 * only as its own step, so changing how an agent behaves never changes its capabilities.
 */
export const AgentSettingsModal = ({
  target,
  overseer,
  authenticatedApi,
  envCandidates,
  otherAgents,
  onClose,
  onSaved,
}: AgentSettingsModalProps) => {
  // The configuration as last read or saved: the server refuses an edit made against a stale one.
  const [saved, setSaved] = useState<AgentSpawnerConfig | null>(null)
  const [createdByYou, setCreatedByYou] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [availableModels, setAvailableModels] = useState<AiChatAuthorInfo[]>([])
  const [displayName, setDisplayName] = useState('')
  const [modelId, setModelId] = useState<string | null>(null)
  const [instructions, setInstructions] = useState('')
  const [rows, setRows] = useState<SpawnerEnvRow[]>([])
  const [busy, setBusy] = useState<'behaviour' | 'capabilities' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    setSaved(null)
    setLoadError(null)
    setError(null)
    setNotice(null)
    if (!target) return
    let cancelled = false
    const selfId = target.gatekeeperId
    Promise.all([
      overseer.getAgentSpawner(selfId),
      // Never offer an agent that would let this one spawn itself.
      agentsReaching(selfId, envCandidates.map((c) => c.target),
        async (id) => (await overseer.getAgentSpawner(id)).config.env),
    ]).then(([{ config, createdByYou: mine }, reaching]) => {
      if (cancelled) return
      setSaved(config)
      setCreatedByYou(mine)
      setDisplayName(config.displayName)
      setModelId(config.modelId)
      setInstructions(config.instructions ?? '')
      setRows(rowsForAgentEnv(config.env, envCandidates.filter((c) => !reaching.has(c.target))))
    }).catch((err) => {
      if (cancelled) return
      reportIssue('connections.agent-load', err)
      setLoadError(errorText(err, 'Could not load this agent.'))
    })
    authenticatedApi?.listModels().then((models) => {
      if (!cancelled) setAvailableModels(models)
    }).catch(() => {})
    return () => {
      cancelled = true
    }
    // Reload only when another agent is opened; candidates changing underneath keep the edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, overseer, authenticatedApi])

  const behaviour: AgentSpawnerBehaviour = {}
  if (saved) {
    if (displayName.trim() !== saved.displayName) behaviour.displayName = displayName.trim()
    if (modelId !== saved.modelId) behaviour.modelId = modelId
    if (instructions.trim() !== (saved.instructions ?? '')) behaviour.instructions = instructions.trim()
  }
  const behaviourChanged = Object.keys(behaviour).length > 0
  const envError = validateSpawnerEnv(rows)
  const env = spawnerEnvFromRows(rows)
  const envChanged = saved !== null &&
    JSON.stringify(Object.entries(env).toSorted()) !== JSON.stringify(Object.entries(saved.env).toSorted())

  const saveBehaviour = async () => {
    if (!saved || !target || !behaviourChanged) return
    setBusy('behaviour')
    setError(null)
    setNotice(null)
    try {
      setSaved(await overseer.updateAgentSpawner(target.gatekeeperId, saved, behaviour))
      setNotice('Saved. Agents spawned from now on use these settings.')
      onSaved()
    } catch (err) {
      reportIssue('connections.agent-save', err)
      setError(errorText(err, 'Could not save this agent.'))
    } finally {
      setBusy(null)
    }
  }

  const saveCapabilities = async () => {
    if (!saved || !target || !envChanged || envError) return
    setBusy('capabilities')
    setError(null)
    setNotice(null)
    try {
      setSaved(await overseer.setAgentSpawnerEnv(target.gatekeeperId, saved, env))
      setNotice("Capabilities changed. Agents spawned from now on can reach exactly what's switched on.")
      onSaved()
    } catch (err) {
      reportIssue('connections.agent-capabilities', err)
      setError(errorText(err, "Could not change this agent's capabilities."))
    } finally {
      setBusy(null)
    }
  }

  // Start from another agent's selection: switch on what it reaches here, under its names. Saving it
  // is still this agent's own explicit capability change.
  const startFrom = async (name: string) => {
    setError(null)
    try {
      const agent = otherAgents.find((a) => a.name === name)
      if (!agent) return
      const { config: other } = await overseer.getAgentSpawner(agent.gatekeeperId)
      setRows(rowsFromOtherAgent(rows, other.env))
    } catch (err) {
      setError(errorText(err, "Could not read that agent's capabilities."))
    }
  }

  return (
    <Dialog.Root open={target !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog className="responsive-dialog !z-[1000] !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !w-[min(520px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0" size="lg">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
              Agent settings
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              {target?.title ?? ''}
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton {...props} aria-label="Close">
                <X size={16} />
              </WorkshopIconButton>
            )}
          />
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 sm:px-5">
          {loadError ? (
            <div className="text-[13px] text-kumo-subtle">{loadError}</div>
          ) : !saved ? (
            <div className="py-2 text-center text-[13px] text-kumo-subtle">Loading...</div>
          ) : (
            <>
              <div className="grid gap-3">
                <AgentSpawnerConfigForm
                  availableModels={availableModels}
                  displayName={displayName}
                  modelId={modelId}
                  instructions={instructions}
                  onDisplayNameChange={setDisplayName}
                  onModelIdChange={setModelId}
                  onInstructionsChange={setInstructions}
                  lockedReason={createdByYou ? undefined : CREATOR_ONLY}
                />
                <div className="flex justify-end">
                  <WorkshopButton
                    tone="primary"
                    onClick={saveBehaviour}
                    disabled={busy !== null || !behaviourChanged || !displayName.trim()}
                  >
                    {busy === 'behaviour' ? 'Saving...' : 'Save'}
                  </WorkshopButton>
                </div>
              </div>

              <div className="grid gap-3 border-t border-kumo-line pt-4">
                <p className="text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                  Capabilities
                </p>
                <p className="text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                  Changed only here, never by the settings above. Agents already running keep what
                  they started with. Only the person who created this agent can change this.
                </p>
                {createdByYou && otherAgents.length > 0 && (
                  <ConnectionConfigField
                    label="Start from another agent"
                    description="Copy another agent's selection, then review it before saving."
                  >
                    <Select
                      aria-label="Start from another agent's capabilities"
                      className="w-full text-sm [&_button]:!h-9"
                      placeholder="Choose an agent"
                      value={null}
                      onValueChange={(v) => { if (v) void startFrom(v as string) }}
                    >
                      {otherAgents.map((agent) => (
                        <Select.Option key={agent.name} value={agent.name}>
                          {agent.title}
                        </Select.Option>
                      ))}
                    </Select>
                  </ConnectionConfigField>
                )}
                <AgentBindingsField
                  env={rows}
                  envError={envError}
                  onEnvChange={setRows}
                  disabled={!createdByYou}
                  description="What this agent's spawned agents can reach, and the names they see it under."
                />
                {createdByYou && <div className="flex justify-end">
                  <WorkshopButton
                    onClick={saveCapabilities}
                    disabled={busy !== null || !envChanged || envError !== null}
                  >
                    {busy === 'capabilities' ? 'Saving...' : 'Save capabilities'}
                  </WorkshopButton>
                </div>}
              </div>
            </>
          )}
        </div>

        {(error || notice) && (
          <div className="shrink-0 border-t border-kumo-line px-4 py-3 sm:px-5">
            <div className="flex items-start gap-2 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-[12px] leading-[18px] font-normal tracking-[-0.2px] text-kumo-default" role={error ? 'alert' : 'status'}>
              {error && <Warning size={14} weight="fill" className="mt-0.5 shrink-0 text-kumo-brand" />}
              <span>{error ?? notice}</span>
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
