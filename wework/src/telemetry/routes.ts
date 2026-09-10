import { resolveDshRoute } from '@/features/dsh-runtime/dshRoutes'
import type { AnalyticsEventMap } from './events'

type TelemetryFeature = AnalyticsEventMap['feature_opened']['feature']

const SMART_APP_FEATURES = new Set<TelemetryFeature>([
  'smart_apps_marketplace',
  'smart_apps_owned',
  'smart_app',
])

export function telemetryDomainForFeature(feature: TelemetryFeature) {
  return SMART_APP_FEATURES.has(feature) ? ('smart_app' as const) : undefined
}

export function telemetryFeatureForLocation(pathname: string, search: string) {
  const searchParams = new URLSearchParams(search)
  if (pathname === '/sites' && searchParams.get('app_type') === 'smart_app') {
    return searchParams.get('view') === 'owned'
      ? ('smart_apps_owned' as const)
      : ('smart_apps_marketplace' as const)
  }
  if (pathname.startsWith('/app/harness-')) return 'smart_app' as const
  if (pathname === '/login' || pathname === '/login/oidc') return 'login' as const
  const pluginRoute = resolveDshRoute(pathname)
  if (pluginRoute) return pluginRoute.telemetryFeature
  if (pathname.startsWith('/app/')) return 'apps' as const
  if (pathname.startsWith('/settings')) return 'settings' as const
  if (pathname.startsWith('/project-space')) return 'project_space' as const
  if (pathname === '/') return 'workbench' as const
  return 'unknown' as const
}
