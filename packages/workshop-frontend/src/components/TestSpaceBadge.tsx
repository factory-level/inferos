import { Badge } from '@cloudflare/kumo'

/**
 * Marks a workspace that is test-only (`GadgetMetadata.testOnly`): it may hold installs that use
 * mock data or models, so what it shows is not real. Shown wherever the space is.
 */
export const TestSpaceBadge = () =>
  <Badge variant="secondary">Test space</Badge>
