import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

/**
 * The `src` for a blueprint's screenshot. The `screenshotUrl` route serves only screenshots that
 * reach beyond the deployment and carries no session, so a signed-in viewer reads the bytes through
 * `getBlueprintScreenshot` instead and gets a blob URL, revoked when the screenshot changes or the
 * caller unmounts. Without `api` (signed out) it is the public URL. Undefined while loading, when
 * there is no screenshot, or when it can't be read, so callers show their placeholder.
 */
export const useBlueprintScreenshotSrc = (
  api: RpcStub<AuthenticatedApi> | null,
  blueprintId: string | undefined,
  screenshotUrl: string | undefined,
): string | undefined => {
  // Keyed by the URL it was read for, so a blob is never shown for another screenshot.
  const [loaded, setLoaded] = useState<{ key: string; src: string } | null>(null)

  useEffect(() => {
    if (!api || !blueprintId || !screenshotUrl) return
    let cancelled = false
    let objectUrl: string | undefined
    api.getBlueprintScreenshot(blueprintId).then(screenshot => {
      if (cancelled || !screenshot) return
      objectUrl = URL.createObjectURL(new Blob([screenshot.content as BlobPart], { type: screenshot.mimeType }))
      setLoaded({ key: screenshotUrl, src: objectUrl })
    }, () => {
      // The placeholder stands in for a screenshot that can't be read.
    })
    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        setLoaded(null)
      }
    }
  }, [api, blueprintId, screenshotUrl])

  if (!screenshotUrl) return undefined
  if (!api) return screenshotUrl
  return loaded?.key === screenshotUrl ? loaded.src : undefined
}
