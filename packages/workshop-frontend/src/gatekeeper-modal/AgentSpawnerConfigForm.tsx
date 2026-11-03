import { Select } from '@cloudflare/kumo'
import { AiChatAuthorInfo, MAX_INSTANCE_INSTRUCTIONS_LENGTH, WorkpieceId, validateBindingName } from '@gadgets/workshop-shared/api'
import { WorkshopInput, WorkshopInputArea } from '../components/WorkshopControls'
import { AgentBindingsField } from './AgentBindingsField'
import { ConnectionConfigField } from './ConnectionConfigField'

/**
 * One prospective entry of AgentSpawnerConfig.env: a workpiece the spawned agents may use, and
 * the name they see it under. Candidates are prefilled from the gadget the spawner is being
 * created for (its own bindings, plus the gadget itself); the user toggles them on or off and may
 * rename them. Choosing targets the gadget doesn't already hold isn't supported here yet.
 */
export interface SpawnerEnvRow {
  /** The workpiece the entry points at. */
  target: WorkpieceId

  /** Display name of the target, e.g. the connected resource's title. */
  targetTitle: string

  /** Name the spawned agents will see the target under (`env.NAME`). */
  name: string

  /** Whether the entry is included in the spawner's env at all. */
  enabled: boolean
}

/**
 * Returns a human-readable complaint about the env rows, or null if they're acceptable. Only
 * enabled rows matter: a disabled row is simply not part of the env.
 */
export function validateSpawnerEnv(rows: SpawnerEnvRow[]): string | null {
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row.enabled) continue
    try {
      validateBindingName(row.name)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    if (seen.has(row.name)) {
      return `Two bindings are both named "${row.name}".`
    }
    seen.add(row.name)
  }
  return null
}

/** Converts the rows into the AgentSpawnerConfig.env map. Assumes validateSpawnerEnv() passed. */
export function spawnerEnvFromRows(rows: SpawnerEnvRow[]): Record<string, WorkpieceId> {
  const env: Record<string, WorkpieceId> = {}
  for (const row of rows) {
    if (row.enabled) env[row.name] = row.target
  }
  return env
}

/**
 * The rows for an existing agent's env: every entry it has, switched on under its current name,
 * then each candidate it doesn't use, switched off. Targets outside the candidates keep the target
 * id as their title, so nothing the agent can reach is hidden.
 */
export function rowsForAgentEnv(
  env: Record<string, WorkpieceId>,
  candidates: Omit<SpawnerEnvRow, 'enabled'>[],
): SpawnerEnvRow[] {
  const titles = new Map(candidates.map((c) => [c.target, c.targetTitle]))
  const used = new Set(Object.values(env))
  return [
    ...Object.entries(env).map(([name, target]) => ({
      target, name, enabled: true, targetTitle: titles.get(target) ?? `Workpiece ${target}`,
    })),
    ...candidates.filter((c) => !used.has(c.target)).map((c) => ({ ...c, enabled: false })),
  ]
}

/** The agent's bindings, when the form edits them together with the rest. */
interface AgentSpawnerEnvProps {
  env: SpawnerEnvRow[]
  envError: string | null
  onEnvChange: (env: SpawnerEnvRow[]) => void
}

export type AgentSpawnerConfigFormProps = {
  availableModels: AiChatAuthorInfo[]
  displayName: string
  modelId: string | null
  instructions: string
  onDisplayNameChange: (value: string) => void
  onModelIdChange: (id: string | null) => void
  onInstructionsChange: (value: string) => void
  /** Present when the form also edits the agent's bindings (creating one); absent when they are edited apart. */
  bindings?: AgentSpawnerEnvProps
}

export function AgentSpawnerConfigForm({
  availableModels,
  displayName,
  modelId,
  instructions,
  onDisplayNameChange,
  onModelIdChange,
  onInstructionsChange,
  bindings,
}: AgentSpawnerConfigFormProps) {
  return (
    <section className="grid gap-4">
      <ConnectionConfigField
        label="Display name"
        description="Name this agent capability for this connection."
      >
        <WorkshopInput
          aria-label="Agent display name"
          placeholder="e.g. Email Responder"
          value={displayName}
          onChange={(e) => onDisplayNameChange(e.target.value)}
          className="w-full"
        />
      </ConnectionConfigField>

      <ConnectionConfigField
        label="Model"
        description="Choose the model spawned agents will use."
      >
        <Select
          aria-label="Agent model"
          className="w-full text-sm [&_button]:!h-9"
          placeholder="Select a model"
          value={modelId}
          onValueChange={(v) => onModelIdChange(v as string | null)}
          renderValue={(id) => {
            if (id === null) return 'None (no agent)'
            return availableModels.find((m) => m.id === id)?.name ?? String(id)
          }}
        >
          <Select.Option value={null as any}>
            None (no agent)
          </Select.Option>
          {availableModels.map(model => (
            <Select.Option key={model.id} value={model.id}>
              {model.name}
            </Select.Option>
          ))}
        </Select>
        <p className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
          Choose "None" to create conversations without an agent.
        </p>
      </ConnectionConfigField>

      <ConnectionConfigField
        label="Instructions"
        description="What this agent is for. It shapes how spawned agents work, never what they can reach."
      >
        <WorkshopInputArea
          aria-label="Agent instructions"
          placeholder="e.g. Triage new service enquiries and draft a reply for review."
          value={instructions}
          maxLength={MAX_INSTANCE_INSTRUCTIONS_LENGTH}
          onChange={(e) => onInstructionsChange(e.target.value)}
          rows={4}
          className="w-full"
        />
      </ConnectionConfigField>

      {bindings && <AgentBindingsField {...bindings} />}
    </section>
  )
}
