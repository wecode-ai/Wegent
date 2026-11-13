import type { BrowserWindowConstructorOptions } from 'electron'

const ENABLED_VALUES = new Set(['1', 'true', 'yes'])

export function desktopE2EWindowOptions(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Pick<BrowserWindowConstructorOptions, 'enableLargerThanScreen'> {
  if (
    platform === 'darwin' &&
    environment.VITE_WEWORK_E2E === 'true' &&
    environment.WEWORK_E2E_CONTROL_URL?.trim()
  ) {
    return { enableLargerThanScreen: true }
  }
  return {}
}

export function keepDesktopE2EInBackground(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): boolean {
  if (platform !== 'darwin') return false
  const value = environment.WEWORK_E2E_BACKGROUND_WINDOW?.trim().toLowerCase()
  return value ? ENABLED_VALUES.has(value) : false
}
