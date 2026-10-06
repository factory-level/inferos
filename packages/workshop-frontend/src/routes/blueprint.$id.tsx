import { createFileRoute } from '@tanstack/react-router'
import { useRpcStub } from '../RpcContext'
import BlueprintLandingPage from '../BlueprintLandingPage'

type BlueprintSearch = { space?: string }

export const Route = createFileRoute('/blueprint/$id')({
  component: BlueprintRoute,
  // `space`: install into that workspace (from the publication review) instead of creating one.
  validateSearch: (search: Record<string, unknown>): BlueprintSearch => ({
    space: typeof search.space === 'string' && /^[0-9a-f]{64}$/.test(search.space) ? search.space : undefined,
  }),
})

function BlueprintRoute() {
  const rpcStub = useRpcStub()
  return <BlueprintLandingPage rpcStub={rpcStub} />
}
