import { resolveDshRoute } from '@/features/dsh-runtime/dshRoutes'

export function telemetryFeatureForLocation(pathname: string, search: string) {
  const searchParams = new URLSearchParams(search)
  if (pathname === '/sites' && searchParams.get('app_type') === 'smart_app') {
    return 'sites' as const
  }
  if (pathname.startsWith('/app/harness-')) return 'apps' as const
  if (pathname === '/login' || pathname === '/login/oidc') return 'login' as const
  const pluginRoute = resolveDshRoute(pathname)
  if (pluginRoute) return pluginRoute.telemetryFeature
  if (pathname.startsWith('/app/')) return 'apps' as const
  if (pathname.startsWith('/settings')) return 'settings' as const
  if (pathname.startsWith('/project-space')) return 'project_space' as const
  if (pathname === '/') return 'workbench' as const
  return 'unknown' as const
}
