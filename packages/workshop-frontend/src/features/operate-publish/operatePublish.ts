import type {
  BlueprintInstall, BlueprintMetadata, GadgetSummary, WorkpieceId, WorkpieceSummary, WorkspaceKind,
} from '@gadgets/workshop-shared/api'

/** The published version an install or upgrade would use: the blueprint's current one. */
export type Candidate = {
  blueprintId: string
  title: string
  version: number
  kind: WorkspaceKind
  /** Absent when the version declared none, which the kernel treats as unknown. */
  dataContract?: number
  /** Binding names the version needs; an install with any must choose them on the blueprint page. */
  bindings: string[]
}

/** The candidate a blueprint's public metadata describes. */
export const candidateOf = (blueprintId: string, metadata: BlueprintMetadata): Candidate => ({
  blueprintId,
  title: metadata.title,
  version: metadata.version,
  kind: metadata.kind ?? 'app',
  ...(metadata.dataContract !== undefined ? { dataContract: metadata.dataContract } : {}),
  bindings: Object.keys(metadata.bindings),
})

/** One install of a blueprint in a space: the gadget and what it runs. */
export type SpaceInstall = { gadgetId: WorkpieceId, title: string, installedFrom: BlueprintInstall }

/** The gadgets in a space installed from `blueprintId`, in id order. */
export const installsOf = (workpieces: Iterable<WorkpieceSummary>, blueprintId: string): SpaceInstall[] =>
  [...workpieces]
    .filter((workpiece): workpiece is GadgetSummary & { installedFrom: BlueprintInstall } =>
      workpiece.type === 'gadget' && workpiece.installedFrom?.blueprintId === blueprintId)
    .map(gadget => ({ gadgetId: gadget.id, title: gadget.title, installedFrom: gadget.installedFrom }))
    .toSorted((a, b) => a.gadgetId - b.gadgetId)

/** Why an install can't be upgraded to the candidate, mirroring the kernel's checks. */
export type UpgradeBlock = 'current' | 'wrongKind' | 'needsMigration' | 'unknownContract'

/**
 * Whether `installed` may move to `candidate`, or why not. The kernel decides; this only explains
 * the decision before the person asks, so a refused upgrade is never offered as a button.
 */
export function upgradeBlock(installed: BlueprintInstall, candidate: Candidate): UpgradeBlock | null {
  if (installed.version === candidate.version) return 'current'
  if (installed.kind !== candidate.kind) return 'wrongKind'
  if (installed.dataContract === undefined || candidate.dataContract === undefined) return 'unknownContract'
  if (installed.dataContract !== candidate.dataContract) return 'needsMigration'
  return null
}

/** One sentence for each reason an upgrade is not offered. */
export function upgradeBlockText(block: UpgradeBlock, installed: BlueprintInstall, candidate: Candidate): string {
  switch (block) {
    case 'current':
      return `Runs the current version, ${candidate.version}.`
    case 'wrongKind':
      return `Version ${candidate.version} is a ${candidate.kind}; this install is a ${installed.kind}, and an upgrade cannot change it.`
    case 'unknownContract':
      return installed.dataContract === undefined
        ? `Version ${installed.version} declared no data contract, so its data compatibility is unknown and it cannot be upgraded.`
        : `Version ${candidate.version} declared no data contract, so its data compatibility is unknown.`
    case 'needsMigration':
      return `Needs migration: version ${candidate.version} declares data contract ${candidate.dataContract}, the installed version ${installed.dataContract}.`
  }
}

/** The failure states the review shows, from the kernel's refusals. */
export type PublicationFailure =
  | 'wrongKind' | 'needsMigration' | 'unknownContract' | 'mockDependency' | 'missingBinding'
  | 'revokedBinding' | 'changed' | 'notFound' | 'notAllowed' | 'other'

// The kernel's refusal messages (blueprint-install.ts, Overseer.installBlueprint/upgradeInstall).
const FAILURE_PATTERNS: [RegExp, PublicationFailure][] = [
  [/needs migration/, 'needsMigration'],
  [/declares no data contract/, 'unknownContract'],
  [/not test-only, so it cannot install mock/, 'mockDependency'],
  [/cannot change the install's kind|is an? \w+, not an? \w+/, 'wrongKind'],
  [/needs the bindings? /, 'missingBinding'],
  [/No such account|No such model|Failed to create gatekeeper/, 'revokedBinding'],
  [/changed during the upgrade/, 'changed'],
  [/must stay test-only/, 'mockDependency'],
  [/not found/, 'notFound'],
  [/^Unauthorized/, 'notAllowed'],
]

/** Classifies a refused publish, install or upgrade by the kernel's message. */
export function publicationFailure(message: string): PublicationFailure {
  return FAILURE_PATTERNS.find(([pattern]) => pattern.test(message))?.[1] ?? 'other'
}

/** What the person can do about a failure, shown after the kernel's own message. */
export const FAILURE_ADVICE: Record<PublicationFailure, string> = {
  wrongKind: 'Nothing was changed. Publish a version of the kind this install runs.',
  needsMigration: 'Nothing was changed. A different data contract needs a reviewed migration first.',
  unknownContract: 'Nothing was changed. Publish a version that declares its data contract.',
  mockDependency: 'Nothing was installed. Choose real connections and models, or mark the space test-only.',
  missingBinding: 'Nothing was changed. Connect the missing binding in the space, then upgrade.',
  revokedBinding: 'Nothing was installed. Reconnect the account or choose another, then try again.',
  changed: 'The install changed while upgrading; the review shows its current version. Try again.',
  notFound: 'That version is no longer available. The review shows what is published now.',
  notAllowed: 'You need build access to the space for this.',
  other: 'The last usable version stays installed.',
}

/** The message of a caught value, for display. */
export const messageOf = (caught: unknown) =>
  caught instanceof Error ? caught.message : String(caught)
