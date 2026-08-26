export interface DesktopE2ERuntimeConfig {
  cloudBackendUrl?: string
  cloudToken?: string
  codexHomeInitialization?: boolean
  controlToken?: string
  controlUrl?: string
  localModelsCatalogReady?: boolean
  modelServerUrl?: string
  posthogHost?: string
  posthogKey?: string
  seedLocalModels?: boolean
  transcriptPageSize?: number
  worktreeCreationDelayMs?: number
}

let runtimeConfig: DesktopE2ERuntimeConfig | null = null

export async function loadDesktopE2ERuntimeConfig(): Promise<void> {
  runtimeConfig = window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ ?? null
}

export function getDesktopE2ERuntimeConfig(): DesktopE2ERuntimeConfig {
  return runtimeConfig ?? window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ ?? {}
}

declare global {
  interface Window {
    __WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__?: DesktopE2ERuntimeConfig
  }
}
