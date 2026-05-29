import { getRuntimeConfig, joinAppPath } from '@/config/runtime'

export function toBrowserPath(path: string): string {
  return joinAppPath(getRuntimeConfig().appBasePath, path)
}

export function navigateTo(path: string) {
  const browserPath = toBrowserPath(path)
  if (window.location.pathname === browserPath) return

  window.history.pushState({}, '', browserPath)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
