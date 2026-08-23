import { invoke } from '@tauri-apps/api/core'

export interface DesktopE2ERuntimeConfig {
  cloudBackendUrl?: string
  cloudToken?: string
  controlToken?: string
  controlUrl?: string
  modelServerUrl?: string
  posthogHost?: string
}

let runtimeConfig: DesktopE2ERuntimeConfig | null = null

declare global {
  interface Window {
    __WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__?: DesktopE2ERuntimeConfig
  }
}

export async function loadDesktopE2ERuntimeConfig(): Promise<void> {
  const injectedConfig = window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
  if (injectedConfig) {
    runtimeConfig = injectedConfig
    return
  }
  runtimeConfig = await invoke<DesktopE2ERuntimeConfig | null>(
    'get_desktop_e2e_runtime_config'
  ).catch(() => null)
}

export function getDesktopE2ERuntimeConfig(): DesktopE2ERuntimeConfig {
  return runtimeConfig ?? {}
}
