import { getRuntimeConfig } from '@/config/runtime'

function joinBrowserPath(basePath: string | undefined, path: string): string {
  const normalizedBasePath = !basePath || basePath === '/' ? '' : basePath.replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  if (!normalizedBasePath) return normalizedPath
  if (normalizedPath === '/') return `${normalizedBasePath}/`
  return `${normalizedBasePath}${normalizedPath}`
}

export function toBrowserPath(path: string): string {
  return joinBrowserPath(getRuntimeConfig().appBasePath, path)
}

export function navigateTo(path: string) {
  const browserPath = toBrowserPath(path)
  const currentPath = `${window.location.pathname}${window.location.search}`
  if (currentPath === browserPath) return

  window.history.pushState({}, '', browserPath)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export interface RuntimeTaskRoute {
  deviceId: string
  taskId: string
  workspacePath?: string | null
}

export type RuntimeTaskRouteInput = RuntimeTaskRoute

function getRequiredSearchParam(
  searchParams: URLSearchParams,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = searchParams.get(name)
    if (value && value.trim()) {
      return value
    }
  }
  return undefined
}

export function parseRuntimeTaskRoute(path: string, search = ''): RuntimeTaskRoute | null {
  if (path !== '/runtime-tasks') return null

  const searchParams = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const deviceId = getRequiredSearchParam(searchParams, 'deviceId', 'device_id')
  const taskIdParam = getRequiredSearchParam(searchParams, 'taskId', 'task_id')
  if (!deviceId || !taskIdParam) return null

  return { deviceId, taskId: taskIdParam }
}

export function buildRuntimeTaskRoute(address: RuntimeTaskRouteInput): string {
  const searchParams = new URLSearchParams()
  searchParams.set('deviceId', address.deviceId)
  searchParams.set('taskId', String(address.taskId))
  return `/runtime-tasks?${searchParams.toString()}`
}

export function isSettingsRoute(path: string): boolean {
  return path === '/settings' || path.startsWith('/settings/')
}
