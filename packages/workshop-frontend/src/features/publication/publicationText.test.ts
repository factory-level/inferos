import { describe, expect, it } from 'vitest'
import { createPublicationError, PUBLICATION_ERROR_CODES, type ServerConfig } from '@gadgets/workshop-shared/api'
import { canPublishKind, isPublicationOffered, publicationErrorMessage } from './publicationText'

const config = (widget: boolean, app: boolean) => ({
  publication: { flags: { PUBLISH_CLOUDFLAREOS_WIDGET: widget, PUBLISH_CLOUDFLAREOS_APP: app }, selfApproval: false },
}) as unknown as ServerConfig

describe('publication flags in the UI', () => {
  it('maps workflows to the app flag and offers nothing while loading or on older deployments', () => {
    expect(canPublishKind(config(false, true), 'workflow')).toBe(true)
    expect(canPublishKind(config(true, false), 'workflow')).toBe(false)
    expect(canPublishKind(config(true, false), 'widget')).toBe(true)
    expect(canPublishKind(null, 'app')).toBe(false)
    expect(isPublicationOffered(null)).toBe(false)
    expect(isPublicationOffered({} as ServerConfig)).toBe(false)
    expect(isPublicationOffered(config(false, true))).toBe(true)
  })

  it('explains a refused download, and passes other server messages through', () => {
    expect(publicationErrorMessage(createPublicationError(PUBLICATION_ERROR_CODES.notPublished), 'x'))
      .toContain('approved export publication')
    expect(publicationErrorMessage(createPublicationError(PUBLICATION_ERROR_CODES.appFlagOff), 'x'))
      .toContain('PUBLISH_CLOUDFLAREOS_APP')
    expect(publicationErrorMessage('nope', 'Fallback')).toBe('Fallback')
  })
})
