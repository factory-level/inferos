import { useEffect } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'
import { useServerConfig } from '../../ServerConfigContext'
import { modeForPath, rememberBuildLocation, type AppMode } from './operateMode'

/**
 * Whether the Build | Operate split is offered: the `operate-mode` UI flag is on and the deployment
 * has composable views (Operate is the InferOps Canvas, which needs them). Off, the shell is the
 * plain Workshop.
 */
export const useOperateModeAvailable = () => {
  const { enabled } = useUiFeatureFlag('operate-mode')
  const composableViews = useServerConfig()?.canvasFeatures?.composableViews === true
  return enabled && composableViews
}

/** The current mode, derived from the URL, while remembering each Build location for the toggle. */
export const useAppMode = (): AppMode => {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const href = useRouterState({ select: (s) => s.location.href })
  useEffect(() => rememberBuildLocation(pathname, href), [pathname, href])
  return modeForPath(pathname)
}
