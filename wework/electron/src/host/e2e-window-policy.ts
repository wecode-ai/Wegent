const ENABLED_VALUES = new Set(['1', 'true', 'yes'])

export function keepDesktopE2EInBackground(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): boolean {
  if (platform !== 'darwin') return false
  const value = environment.WEWORK_E2E_BACKGROUND_WINDOW?.trim().toLowerCase()
  return value ? ENABLED_VALUES.has(value) : false
}
