// How a board or Wiki widget reaches its InferOps session (inferos ADR 0015): through the
// workspace's connection for exactly its reference, else through the workspace's InferOps account
// connection for the reference's organization (`inferops://<tenant>/account`), which opens the board
// or Wiki and checks the reference then. Both are exact lookups over connections the workspace
// already holds (Overseer.getGatekeeperByResourceUrl): a reference never creates or selects a
// connection by itself, and a workspace with neither leaves the widget unbound. Coding dispatch
// does not come through here; it needs its own connection.
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { InferOpsAccountSession, InferOpsProjectSession, InferOpsWikiSession } from '@inferos/gatekeeper-inferops/src/types'

/** What a widget opens: a project board or one InferMind workspace's Wiki. */
export type InferOpsSessionKind = 'board' | 'wiki'

/**
 * The account connection URL for a board or Wiki reference's organization: the tenant label of its
 * `<tenant>.<workspace>` host, or the demo account for `demo.local`. Null when the reference names
 * no such host; the gatekeeper validates everything else when it opens the reference.
 */
export const accountUrlFor = (target: string): string | null => {
  const host = /^inferops:\/\/([^/?#]+)\//i.exec(target.trim())?.[1]?.toLowerCase()
  if (host === undefined) return null
  if (host === 'demo.local') return 'inferops://demo.local/account'
  const [tenant, workspace, ...rest] = host.split('.')
  return tenant && workspace && rest.length === 0 ? `inferops://${tenant}/account` : null
}

/**
 * The session for `target`, or null when the workspace holds neither its exact connection nor an
 * account connection for its organization. The account connection's refusal of the reference
 * (`NOT_FOUND`) rejects: the widget shows it as an error, not as unbound. Every stub but the
 * returned session is disposed here.
 */
export function openInferOpsSession(overseer: RpcStub<Overseer>, target: string, kind: 'board'):
  Promise<RpcStub<InferOpsProjectSession> | null>
export function openInferOpsSession(overseer: RpcStub<Overseer>, target: string, kind: 'wiki'):
  Promise<RpcStub<InferOpsWikiSession> | null>
export async function openInferOpsSession(overseer: RpcStub<Overseer>, target: string, kind: InferOpsSessionKind):
    Promise<RpcStub<InferOpsProjectSession> | RpcStub<InferOpsWikiSession> | null> {
  const exact = await overseer.getGatekeeperByResourceUrl(target)
  if (exact) {
    try {
      return await exact.openSession() as RpcStub<InferOpsProjectSession> | RpcStub<InferOpsWikiSession>
    } finally {
      exact[Symbol.dispose]()
    }
  }
  const accountUrl = accountUrlFor(target)
  if (accountUrl === null) return null
  const account = await overseer.getGatekeeperByResourceUrl(accountUrl)
  if (!account) return null
  try {
    const session = await account.openSession() as RpcStub<InferOpsAccountSession>
    try {
      // An awaited capability capnweb types as its plain stub shape; it is the same stub the
      // exact connection's openSession() returns, so it is typed as one.
      return kind === 'board'
        ? await session.openBoard(target) as unknown as RpcStub<InferOpsProjectSession>
        : await session.openWiki(target) as unknown as RpcStub<InferOpsWikiSession>
    } finally {
      session[Symbol.dispose]()
    }
  } finally {
    account[Symbol.dispose]()
  }
}
