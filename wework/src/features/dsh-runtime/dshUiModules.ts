import { markDesktopStartupPhase } from '@/lib/desktop-startup-phase'

const modulePromises = new Map<string, Promise<unknown>>()
const loadedModules = new Map<string, unknown>()

declare global {
  interface Window {
    __WEWORK_DSH_UI_MODULES__?: Record<string, unknown | (() => Promise<unknown>)>
  }
}

export function dshUiModuleUrl(module: string): string {
  const appBase = new URL(import.meta.env.BASE_URL, window.location.origin)
  return new URL(module, appBase).href
}

export function importDshUiModule<T>(module: string): Promise<T> {
  const url = dshUiModuleUrl(module)
  const existing = modulePromises.get(url)
  if (existing) return existing as Promise<T>
  const homeModule =
    module === 'plugins/wework-ui-home-developer.js' || module === 'plugins/wework-ui-home-focus.js'
      ? module
      : undefined
  const startedAt = performance.now()
  if (homeModule) {
    markDesktopStartupPhase('home-module-import', 'started', { modulePath: homeModule })
  }
  const injected = window.__WEWORK_DSH_UI_MODULES__?.[module]
  const loading: Promise<unknown> = injected
    ? typeof injected === 'function'
      ? injected()
      : Promise.resolve(injected)
    : import(/* @vite-ignore */ url)
  const loaded = loading.then(
    value => {
      loadedModules.set(url, value)
      if (homeModule) {
        markDesktopStartupPhase('home-module-import', 'completed', {
          modulePath: homeModule,
          durationMs: Math.round(performance.now() - startedAt),
        })
      }
      return value
    },
    error => {
      if (homeModule) {
        markDesktopStartupPhase('home-module-import', 'failed', {
          modulePath: homeModule,
          durationMs: Math.round(performance.now() - startedAt),
        })
      }
      throw error
    }
  )
  modulePromises.set(url, loaded)
  return loaded as Promise<T>
}

export function getLoadedDshUiModule<T>(module: string): T | null {
  return (loadedModules.get(dshUiModuleUrl(module)) as T | undefined) ?? null
}

export function clearDshUiModuleCache(): void {
  modulePromises.clear()
  loadedModules.clear()
}
