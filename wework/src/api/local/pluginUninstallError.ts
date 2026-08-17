export class LocalPluginUninstallCleanupError extends Error {
  readonly localPluginUninstalled = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalPluginUninstallCleanupError'
  }
}

export function isLocalPluginUninstallCleanupError(
  error: unknown
): error is LocalPluginUninstallCleanupError {
  return (
    error instanceof Error &&
    'localPluginUninstalled' in error &&
    error.localPluginUninstalled === true
  )
}
