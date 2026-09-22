import { isSettingsRoute } from '@/lib/navigation'

const SETTINGS_RETURN_PATH_KEY = 'wework.settingsReturnPath'

function routePathname(route: string): string {
  const searchIndex = route.indexOf('?')
  return searchIndex >= 0 ? route.slice(0, searchIndex) : route
}

export function readSettingsReturnPath(): string | null {
  try {
    return window.sessionStorage.getItem(SETTINGS_RETURN_PATH_KEY)
  } catch {
    return null
  }
}

export function writeSettingsReturnPath(path: string): void {
  if (isSettingsRoute(routePathname(path))) return
  try {
    window.sessionStorage.setItem(SETTINGS_RETURN_PATH_KEY, path)
  } catch {
    // Callers retain an in-memory fallback when session storage is unavailable.
  }
}
