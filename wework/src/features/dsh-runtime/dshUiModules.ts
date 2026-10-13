import { markDesktopStartupPhase } from '@/lib/desktop-startup-phase'
import { loadDshUiStylesheets } from './dshUiStylesheets'

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
  const startupModule =
    module === 'plugins/wework-ui-core-apps.js' ||
    module === 'plugins/wework-ui-home-developer.js' ||
    module === 'plugins/wework-ui-home-focus.js'
      ? module
      : undefined
  const startupPhase =
    module === 'plugins/wework-ui-core-apps.js' ? 'core-app-module-import' : 'home-module-import'
  const startedAt = performance.now()
  if (startupModule) {
    markDesktopStartupPhase(startupPhase, 'started', { modulePath: startupModule })
  }
  const injected = window.__WEWORK_DSH_UI_MODULES__?.[module]
  const loading: Promise<unknown> = injected
    ? typeof injected === 'function'
      ? injected()
      : Promise.resolve(injected)
    : import(/* @vite-ignore */ url)
  const loaded = loading
    .then(async value => {
      await loadDshUiStylesheets(value)
      return value
    })
    .then(
      value => {
        loadedModules.set(url, value)
        if (startupModule) {
          markDesktopStartupPhase(startupPhase, 'completed', {
            modulePath: startupModule,
            durationMs: Math.round(performance.now() - startedAt),
          })
        }
        return value
      },
      error => {
        if (startupModule) {
          markDesktopStartupPhase(startupPhase, 'failed', {
            modulePath: startupModule,
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
