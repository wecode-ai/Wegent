import { getDshApps } from '@/features/dsh-runtime/dshApps'
import { getDshRoutes } from '@/features/dsh-runtime/dshRoutes'
import { getDshSettingsPages } from '@/features/dsh-runtime/dshSettings'
import { openWeworkScheme } from '@/features/notifications/schemeEvents'
import { navigateTo, parseRuntimeTaskRoute, resolveDesktopAppRoute } from '@/lib/navigation'

// Discover destinations from the same contributions that render workbench navigation.
export function appNavigationTargets() {
  return [
    ...getDshRoutes().map(route => ({
      id: route.id,
      path: route.path,
      label: route.title ?? route.id,
      labelKey: route.titleKey,
    })),
    ...getDshSettingsPages().map(page => ({
      id: page.id,
      path: page.path,
      label: page.label,
      labelKey: page.labelKey,
    })),
    ...getDshApps()
      .filter(app => !app.hidden)
      .map(app => ({
        id: app.id,
        path: resolveDesktopAppRoute(app.id),
        label: app.label,
        labelKey: app.labelKey,
      })),
  ]
}

export function openAppNavigation(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'wework:') return false
    if (url.hostname !== 'navigate') return openWeworkScheme(value)
    if (url.username || url.password || url.port || url.search || url.hash) return false
    const path = decodeURIComponent(url.pathname.slice(1))
    if (
      !/^\/(?!\/)/.test(path) ||
      path.includes('\\') ||
      [...path].some(character => character.charCodeAt(0) < 32)
    )
      return false
    const target = new URL(path, 'https://wework.invalid')
    if (target.hash) return false
    const registered = appNavigationTargets().some(entry => entry.path === target.pathname)
    const task = parseRuntimeTaskRoute(target.pathname, target.search)
    if (!registered && !task && !['/', '/settings'].includes(path)) return false
    navigateTo(`${target.pathname}${target.search}`)
    return true
  } catch {
    return false
  }
}
