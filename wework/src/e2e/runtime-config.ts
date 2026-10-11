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
  seedLocalModels?: boolean
  transcriptPageSize?: number
  windowLabel?: string
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

export function isWeworkAutomationEnabled(): boolean {
  if (getDesktopE2ERuntimeConfig().disabled === true) return false
  return (
    import.meta.env.MODE === 'e2e' ||
    import.meta.env.VITE_WEWORK_E2E === 'true' ||
    Boolean(getDesktopE2ERuntimeConfig().controlUrl)
  )
}

export function shouldUseNativeProjectDirectoryPicker(): boolean {
  return (
    !isWeworkAutomationEnabled() ||
    import.meta.env.VITE_WEWORK_E2E_NATIVE_DIRECTORY_PICKER === 'true'
  )
}
