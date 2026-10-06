import {
  getPublicationErrorCode, PUBLICATION_ERROR_CODES, publicationFlagFor,
  type PublicationDestination, type PublicationErrorCode, type PublicationStatus, type ServerConfig,
  type WorkspaceKind,
} from '@gadgets/workshop-shared/api'

/** How each destination is named and what it reaches, as the requester and the reviewer see it. */
export const DESTINATION_TEXT: Record<PublicationDestination, { label: string; reach: string }> = {
  deployment: {
    label: 'This deployment',
    reach: 'Listed for everyone signed in here. They can start their own copy.',
  },
  export: {
    label: 'Export link',
    reach: 'Anyone with the link can view it and download its .gadget archive without signing in. ' +
        'A downloaded archive cannot be recalled.',
  },
}

/** A status as a short label and the badge variant that conveys it. */
export const STATUS_TEXT: Record<PublicationStatus,
    { label: string; variant: 'neutral' | 'success' | 'warning' | 'secondary' }> = {
  requested: { label: 'Awaiting approval', variant: 'warning' },
  active: { label: 'Published', variant: 'success' },
  suspended: { label: 'Suspended: publishing is off', variant: 'secondary' },
  unconfirmed: { label: 'Needs re-confirmation', variant: 'warning' },
  withdrawn: { label: 'Withdrawn', variant: 'neutral' },
}

/** Whether publishing `kind` is switched on for this deployment. Off while the config is loading. */
export function canPublishKind(config: ServerConfig | null, kind: WorkspaceKind): boolean {
  return config?.publication?.flags[publicationFlagFor(kind)] === true
}

/** Whether any publication flag is on, which is when publication UI is offered at all. */
export function isPublicationOffered(config: ServerConfig | null): boolean {
  return Object.values(config?.publication?.flags ?? {}).some(Boolean)
}

const ERROR_TEXT: Partial<Record<PublicationErrorCode, string>> = {
  [PUBLICATION_ERROR_CODES.notPublished]:
      'Downloading needs an approved export publication. Its owner can request one from Build.',
  [PUBLICATION_ERROR_CODES.artifactChanged]:
      'The blueprint has a newer version than this request. Ask the owner to request it again.',
  [PUBLICATION_ERROR_CODES.invalidState]: 'This publication changed. Refresh to see where it stands.',
}

/** A failed publication call as a sentence for the person who made it. */
export function publicationErrorMessage(error: unknown, fallback: string): string {
  const code = getPublicationErrorCode(error)
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code]
  return error instanceof Error && error.message ? error.message : fallback
}
