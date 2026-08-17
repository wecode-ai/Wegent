import { invoke } from '@tauri-apps/api/core'

export interface DesktopE2ERuntimeConfig {
  cloudBackendUrl?: string
  cloudToken?: string
  controlUrl?: string
  modelServerUrl?: string
  posthogHost?: string
}

let runtimeConfig: DesktopE2ERuntimeConfig | null = null

export async function loadDesktopE2ERuntimeConfig(): Promise<void> {
  runtimeConfig = await invoke<DesktopE2ERuntimeConfig | null>(
    'get_desktop_e2e_runtime_config'
  ).catch(() => null)
}

export function getDesktopE2ERuntimeConfig(): DesktopE2ERuntimeConfig {
  return runtimeConfig ?? {}
}
