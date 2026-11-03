import { Checkbox } from '@cloudflare/kumo'
import { WorkshopInput } from '../components/WorkshopControls'
import { ConnectionConfigField } from './ConnectionConfigField'
import type { SpawnerEnvRow } from './AgentSpawnerConfigForm'

export interface AgentBindingsFieldProps {
  env: SpawnerEnvRow[]
  envError: string | null
  onEnvChange: (env: SpawnerEnvRow[]) => void
  /** Overrides the field's description, e.g. to say when a change takes effect. */
  description?: string
}

/**
 * What an agent's spawned agents may reach (AgentSpawnerConfig.env): one row per candidate, which
 * the user switches on or off and may rename.
 */
export const AgentBindingsField = ({
  env,
  envError,
  onEnvChange,
  description = 'What spawned agents may use, and the names they see it under.',
}: AgentBindingsFieldProps) => {
  const updateRow = (index: number, updates: Partial<SpawnerEnvRow>) => {
    onEnvChange(env.map((row, i) => (i === index ? { ...row, ...updates } : row)))
  }

  return (
    <ConnectionConfigField label="Agent bindings" description={description}>
      {env.length === 0 ? (
        <p className="text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
          Nothing is available to offer spawned agents here. Create the agent from a gadget's
          Connections tab to give it access to that gadget and its resources.
        </p>
      ) : (
        <div className="grid gap-2">
          {env.map((row, index) => (
            <div key={`${row.target}:${index}`} className="flex items-center gap-2">
              <Checkbox
                aria-label={`Give spawned agents access to ${row.targetTitle}`}
                checked={row.enabled}
                onCheckedChange={(checked) => updateRow(index, { enabled: checked === true })}
              />
              <WorkshopInput
                aria-label={`Binding name for ${row.targetTitle}`}
                value={row.name}
                disabled={!row.enabled}
                onChange={(e) => updateRow(index, { name: e.target.value })}
                className="!h-8 w-[180px] min-w-0 font-mono"
              />
              <span className="min-w-0 flex-1 truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                {row.targetTitle}
              </span>
            </div>
          ))}
          {envError && (
            <p className="text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-danger">
              {envError}
            </p>
          )}
        </div>
      )}
    </ConnectionConfigField>
  )
}
