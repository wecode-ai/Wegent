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

export interface TaskRoute {
  taskId: number
  projectId?: number
}

export interface RuntimeTaskRoute {
  deviceId: string
  localTaskId: string
}

export interface RuntimeTaskRouteInput extends RuntimeTaskRoute {
  workspacePath?: string
}

function getNumericSearchParam(
  searchParams: URLSearchParams,
  ...names: string[]
): number | undefined {
  for (const name of names) {
    const value = searchParams.get(name)
    if (value === null || value.trim() === '') continue

    const numberValue = Number(value)
    if (Number.isInteger(numberValue) && numberValue >= 0) {
      return numberValue
    }
  }

  return undefined
}

export function parseTaskRoute(path: string, search = ''): TaskRoute | null {
  const searchParams = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const queryProjectId = getNumericSearchParam(searchParams, 'projectId', 'project_id')

  const projectTaskMatch = path.match(/^\/projects\/(\d+)\/tasks\/(\d+)$/)
  if (projectTaskMatch) {
    return {
      projectId: Number(projectTaskMatch[1]),
      taskId: Number(projectTaskMatch[2]),
    }
  }

  const taskMatch = path.match(/^\/tasks\/(\d+)$/)
  if (taskMatch) {
    return { taskId: Number(taskMatch[1]), projectId: queryProjectId }
  }

  const queryTaskId = getNumericSearchParam(searchParams, 'taskId', 'task_id', 'taskid')
  if (queryTaskId !== undefined) {
    return { taskId: queryTaskId, projectId: queryProjectId }
  }

  return null
}

export function buildTaskRoute({ taskId, projectId }: TaskRoute): string {
  if (projectId !== undefined) {
    return `/projects/${projectId}/tasks/${taskId}`
  }
  return `/tasks/${taskId}`
}

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
  const localTaskId = getRequiredSearchParam(searchParams, 'localTaskId', 'local_task_id')
  if (!deviceId || !localTaskId) return null

  return { deviceId, localTaskId }
}

export function buildRuntimeTaskRoute(address: RuntimeTaskRouteInput): string {
  const searchParams = new URLSearchParams()
  searchParams.set('deviceId', address.deviceId)
  searchParams.set('localTaskId', address.localTaskId)
  return `/runtime-tasks?${searchParams.toString()}`
}

export function isSettingsRoute(path: string): boolean {
  return path === '/settings' || path.startsWith('/settings/')
}
