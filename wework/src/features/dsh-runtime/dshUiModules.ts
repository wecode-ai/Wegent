const modulePromises = new Map<string, Promise<unknown>>()

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
  const injected = window.__WEWORK_DSH_UI_MODULES__?.[module]
  const loading: Promise<unknown> = injected
    ? typeof injected === 'function'
      ? injected()
      : Promise.resolve(injected)
    : import(/* @vite-ignore */ url)
  modulePromises.set(url, loading)
  return loading as Promise<T>
}

export function clearDshUiModuleCache(): void {
  modulePromises.clear()
}
