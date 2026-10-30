export interface DesktopE2ERuntimeConfig {
  cloudBackendUrl?: string
  cloudToken?: string
  codexHomeInitialization?: boolean
  controlToken?: string
  controlUrl?: string
  disabled?: boolean
  localModelsCatalogReady?: boolean
  modelServerUrl?: string
  posthogHost?: string
  posthogKey?: string
  telemetryIdentity?: string
  seedLocalModels?: boolean
  transcriptPageSize?: number
  windowLabel?: string
  worktreeCreationDelayMs?: number
}

let runtimeConfig: DesktopE2ERuntimeConfig | null = null
const CLOUD_SESSION_TOKEN_KEY = 'wework.e2e.cloudSessionToken'

function injectedRuntimeConfig(): DesktopE2ERuntimeConfig {
  return runtimeConfig ?? window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ ?? {}
}

export async function loadDesktopE2ERuntimeConfig(): Promise<void> {
  runtimeConfig = window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ ?? null
}

export function getDesktopE2ERuntimeConfig(): DesktopE2ERuntimeConfig {
  const config = injectedRuntimeConfig()
  if (!config.controlUrl || config.disabled) return config
  const token = window.sessionStorage.getItem(CLOUD_SESSION_TOKEN_KEY)
  return token ? { ...config, cloudToken: token } : config
}

export function setDesktopE2ECloudSessionToken(token: string): void {
  const config = injectedRuntimeConfig()
  if (!config.controlUrl || config.disabled) {
    throw new Error('Cloud session switching requires an active desktop E2E controller')
  }
  if (!token.trim()) throw new Error('Cloud session switching requires a backend token')
  window.sessionStorage.setItem(CLOUD_SESSION_TOKEN_KEY, token)
}

declare global {
  interface Window {
    __WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__?: DesktopE2ERuntimeConfig
  }
}
