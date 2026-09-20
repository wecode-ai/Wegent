import { resolveDshAppRoute } from './dsh-app-route.js'

export const VNC_SURFACE_PATH = '/device-desktop'
export const VNC_SURFACE_QUERY_PARAMETER = 'vncSurface'
export const VNC_SURFACE_QUERY_VALUE = 'isolated'
export const VNC_SURFACE_ROUTE_PARTITION_PREFIX = 'wework-vnc-surface-route:'

export function isTrustedVncSurfaceAttachment(
  params: Record<string, unknown>,
  dshUrl: string
): boolean {
  if (typeof params.partition !== 'string') return false
  const routeId = params.partition.slice(VNC_SURFACE_ROUTE_PARTITION_PREFIX.length)
  if (
    !params.partition.startsWith(VNC_SURFACE_ROUTE_PARTITION_PREFIX) ||
    !/^[A-Za-z0-9-]{8,128}$/.test(routeId)
  ) {
    return false
  }
  if (typeof params.src !== 'string') return false

  let target: URL
  try {
    target = new URL(params.src)
  } catch {
    return false
  }

  const expectedOrigin = new URL(dshUrl).origin
  const allowedPaths = new Set([
    VNC_SURFACE_PATH,
    resolveDshAppRoute(dshUrl, VNC_SURFACE_PATH).pathname,
  ])

  if (
    target.origin !== expectedOrigin ||
    !allowedPaths.has(target.pathname) ||
    target.username ||
    target.password ||
    target.hash
  ) {
    return false
  }

  const keys = Array.from(target.searchParams.keys())
  return (
    keys.length === 2 &&
    keys.filter(key => key === 'deviceId').length === 1 &&
    keys.filter(key => key === VNC_SURFACE_QUERY_PARAMETER).length === 1 &&
    Boolean(target.searchParams.get('deviceId')?.trim()) &&
    target.searchParams.get(VNC_SURFACE_QUERY_PARAMETER) === VNC_SURFACE_QUERY_VALUE
  )
}
