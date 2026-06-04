import { getRuntimeConfig } from '@/config/runtime'

function joinBrowserPath(basePath: string | undefined, path: string): string {
  const normalizedBasePath =
    !basePath || basePath === '/' ? '' : basePath.replace(/\/+$/, '')
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
  if (window.location.pathname === browserPath) return

  window.history.pushState({}, '', browserPath)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export interface TaskRoute {
  taskId: number
  projectId?: number
}

export function parseTaskRoute(path: string): TaskRoute | null {
  const projectTaskMatch = path.match(/^\/projects\/(\d+)\/tasks\/(\d+)$/)
  if (projectTaskMatch) {
    return {
      projectId: Number(projectTaskMatch[1]),
      taskId: Number(projectTaskMatch[2]),
    }
  }

  const taskMatch = path.match(/^\/tasks\/(\d+)$/)
  if (taskMatch) {
    return { taskId: Number(taskMatch[1]) }
  }

  return null
}

export function buildTaskRoute({ taskId, projectId }: TaskRoute): string {
  if (projectId && projectId > 0) {
    return `/projects/${projectId}/tasks/${taskId}`
  }
  return `/tasks/${taskId}`
}

export function isSettingsRoute(path: string): boolean {
  return path === '/settings' || path.startsWith('/settings/')
}
