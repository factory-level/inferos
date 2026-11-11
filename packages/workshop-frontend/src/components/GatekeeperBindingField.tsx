import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, BlueprintBindingAssignment } from '@gadgets/workshop-shared/api'
import type { ResourceConfiguratorFrame, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { AccountChooser, type AccountOption } from '../gatekeeper-modal/AccountChooser'
import ResourceConfiguratorHost from '../ResourceConfiguratorHost'

/**
 * What a gatekeeper binding asks for: the gatekeeper, the resource type it accepts and, from a
 * blueprint, a suggested resource. A blueprint's binding and a duplicated workflow's required one
 * (FAC-123, which never carries the source's resource) both fit.
 */
export type GatekeeperBindingNeed = { gatekeeperName: string; typeUrlPattern: string; resourceUrl?: string }

// Dispose the host-side capability bundle returned with a configurator frame, releasing the
// gatekeeper-side resources backing the iframe.
function disposeConfiguratorFrame(frame: ResourceConfiguratorFrame | null) {
  const uiDisposable = frame?.ui as any
  uiDisposable?.[Symbol.dispose]?.()
}

function formatSuggestedResource(resourceUrl: string): string {
  try {
    const path = new URL(resourceUrl).pathname.replace(/^\/+|\/+$/g, '')
    return path || resourceUrl
  } catch {
    return resourceUrl
  }
}

// Renders the connection-wizard-style UI for a single gatekeeper binding: an account chooser
// scoped to the binding's required resource type, plus the vendor-supplied resource configurator
// iframe. The URL is collected from the iframe at submit time via `collectResourceUrl()`.
export const GatekeeperBindingField = ({
  title,
  binding,
  value,
  authenticatedApi,
  vendors,
  accounts,
  connectingVendor,
  reconnectingAccountId,
  onChange,
  onConnectAccount,
  onReconnectAccount,
  onReadyChange,
  onCollectorChange,
}: {
  title: string
  binding: GatekeeperBindingNeed
  value: Partial<BlueprintBindingAssignment>
  authenticatedApi: RpcStub<AuthenticatedApi>
  vendors: {id: string, description: VendorDescription, supportedResources: SupportedResource[]}[]
  accounts: AccountOption[]
  connectingVendor: string | null
  reconnectingAccountId: number | null
  onChange: (updates: Partial<BlueprintBindingAssignment>) => void
  onConnectAccount: (vendorId: string) => void
  onReconnectAccount: (accountId: number) => void
  onReadyChange: (ready: boolean) => void
  onCollectorChange: (collect: (() => Promise<string>) | null) => void
}) => {
  const vendor = useMemo(
    () => vendors.find(v => v.id === binding.gatekeeperName) ?? null,
    [vendors, binding.gatekeeperName],
  )
  const resource = useMemo(
    () => vendor?.supportedResources.find(r => r.urlPattern === binding.typeUrlPattern) ?? null,
    [vendor, binding.typeUrlPattern],
  )

  const matchingAccounts = useMemo(() => accounts.filter(account =>
    account.vendorId === binding.gatekeeperName &&
    account.supportedResources.some(r => r.urlPattern === binding.typeUrlPattern)
  ), [accounts, binding.gatekeeperName, binding.typeUrlPattern])

  const selectedAccountId = (value as any).accountId ?? null
  const selectedAccount = matchingAccounts.find(a => a.id === selectedAccountId && a.credentialsValid) ?? null

  // The parent component re-renders frequently and passes us fresh inline callbacks each time.
  // Stash them in refs so effects below can call the latest versions without re-running every
  // render (which would otherwise re-spin the iframe in an infinite loop).
  const onChangeRef = useRef(onChange)
  const onReadyChangeRef = useRef(onReadyChange)
  const onCollectorChangeRef = useRef(onCollectorChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => { onReadyChangeRef.current = onReadyChange }, [onReadyChange])
  useEffect(() => { onCollectorChangeRef.current = onCollectorChange }, [onCollectorChange])

  // Auto-select the first valid account once accounts arrive.
  useEffect(() => {
    if (selectedAccountId !== null
        && matchingAccounts.some(a => a.id === selectedAccountId && a.credentialsValid)) {
      return
    }
    const first = matchingAccounts.find(a => a.credentialsValid)
    if (first) {
      onChangeRef.current({ accountId: first.id } as any)
    } else if (selectedAccountId !== null) {
      onChangeRef.current({ accountId: undefined } as any)
    }
  }, [matchingAccounts, selectedAccountId])

  // Configurator iframe state. We re-spin the iframe whenever the (account, resource) pair
  // changes; each frame is disposed when replaced or when the component unmounts.
  const [frameState, setFrameState] = useState<{ key: number, frame: ResourceConfiguratorFrame } | null>(null)
  const [frameLoading, setFrameLoading] = useState(false)
  const [frameError, setFrameError] = useState<string | null>(null)
  const frameRef = useRef<{ key: number, frame: ResourceConfiguratorFrame } | null>(null)
  const frameKeyRef = useRef(0)

  const replaceFrameState = useCallback((next: { key: number, frame: ResourceConfiguratorFrame } | null) => {
    const prev = frameRef.current
    if (prev?.frame !== next?.frame) disposeConfiguratorFrame(prev?.frame ?? null)
    frameRef.current = next
    setFrameState(next)
  }, [])

  // Stable callbacks for the configurator host. SandboxedResourceConfigurator's effect uses
  // `onCollectResourceUrlChange` as a dependency, so re-creating these inline each render would
  // cause the collector to briefly be unregistered (cleanup → re-register) on every parent
  // render, leaving a window where handleCreate could see an undefined collector.
  const stableOnCollectorChange = useCallback(
    (collect: (() => Promise<string>) | null) => onCollectorChangeRef.current(collect),
    [],
  )
  const stableOnReadyChange = useCallback(
    (ready: boolean | null) => onReadyChangeRef.current(ready === true),
    [],
  )

  useEffect(() => {
    return () => {
      disposeConfiguratorFrame(frameRef.current?.frame ?? null)
      frameRef.current = null
      onCollectorChangeRef.current(null)
      onReadyChangeRef.current(false)
    }
  }, [])

  useEffect(() => {
    if (!resource || !selectedAccount) {
      replaceFrameState(null)
      setFrameError(null)
      setFrameLoading(false)
      onReadyChangeRef.current(false)
      return
    }

    let cancelled = false
    setFrameLoading(true)
    setFrameError(null)
    onReadyChangeRef.current(false)
    replaceFrameState(null)

    authenticatedApi.startResourceConfigurator(selectedAccount.id, resource.urlPattern)
      .then(frame => {
        if (cancelled) {
          disposeConfiguratorFrame(frame)
          return
        }
        replaceFrameState({ key: ++frameKeyRef.current, frame })
      })
      .catch(err => {
        console.error('Failed to start resource configurator:', err)
        if (!cancelled) setFrameError(err?.message || 'Could not start configurator.')
      })
      .finally(() => {
        if (!cancelled) setFrameLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [authenticatedApi, selectedAccount?.id, resource?.urlPattern, replaceFrameState])

  // Bail out if the gatekeeper isn't installed locally or the required resource type isn't
  // offered by the vendor. The binding can't be satisfied in either case.
  if (!vendor) {
    return (
      <div className="rounded-lg bg-kumo-danger-tint px-3 py-2.5 text-sm text-kumo-danger">
        <p className="font-semibold mb-0.5">{title}</p>
        <p>The "{binding.gatekeeperName}" gatekeeper is not available on this workshop, so this connection can't be configured.</p>
      </div>
    )
  }
  if (!resource) {
    return (
      <div className="rounded-lg bg-kumo-danger-tint px-3 py-2.5 text-sm text-kumo-danger">
        <p className="font-semibold mb-0.5">{title}</p>
        <p>The required resource type for this binding isn't offered by {vendor.description.displayName}.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <AccountChooser
        accounts={matchingAccounts}
        selectedAccountId={selectedAccountId}
        vendorId={binding.gatekeeperName}
        vendorName={vendor.description.displayName}
        resourceTitle={resource.title}
        connecting={connectingVendor === binding.gatekeeperName}
        reconnectingAccountId={reconnectingAccountId}
        onSelect={(id) => onChange({ accountId: id } as any)}
        onConnect={() => onConnectAccount(binding.gatekeeperName)}
        onReconnect={onReconnectAccount}
      />

      {selectedAccount && (
        <div className="space-y-2.5">
          {binding.resourceUrl && (
            <p className="m-0 pl-[2px] text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              Blueprint recommends: <span className="break-all text-kumo-default">{formatSuggestedResource(binding.resourceUrl)}</span>
            </p>
          )}

          <ResourceConfiguratorHost
            frame={frameState?.frame ?? null}
            frameKey={frameState?.key ?? null}
            loading={frameLoading}
            error={frameError}
            disabled={false}
            topOffset={10}
            onCollectResourceUrlChange={stableOnCollectorChange}
            onSelectionReadyChange={stableOnReadyChange}
          />
        </div>
      )}
    </div>
  )
}
