import { requireCloudCredentialOwner } from './cloud-connection-profile.js'
import { RendererStorageStore } from './renderer-storage-store.js'

interface LoginRecovery {
  enabled: boolean
  isShuttingDown: () => boolean
  python: () => Promise<{ resumeAfterLogin(): Promise<unknown> }> | null
  development: () => { resumePythonAfterLogin(): Promise<void> } | null
  cloudConnectionChanged?: (value: string | null) => void | Promise<void>
}

/** Observe committed login state without blocking storage writes or creating Python demand. */
export function createDesktopRendererStorage(directory: string, recovery: LoginRecovery) {
  return new RendererStorageStore(directory, update => {
    if (recovery.isShuttingDown()) return
    if (update.clear || Object.hasOwn(update.changes, 'wework.cloudConnection')) {
      const observe = async () =>
        recovery.cloudConnectionChanged?.(update.changes['wework.cloudConnection'] ?? null)
      void observe().catch(() => console.warn('[workbenches] Cloud connection observer failed'))
    }
    if (!recovery.enabled || recovery.isShuttingDown()) return
    const value = update.changes['wework.cloudConnection']
    if (!value) return
    try {
      const connection = JSON.parse(value)
      if (!connection || typeof connection.apiBaseUrl !== 'string') return
      const api = new URL(connection.apiBaseUrl)
      if (
        !['http:', 'https:'].includes(api.protocol) ||
        api.username ||
        api.password ||
        api.hash ||
        api.search
      )
        return
      requireCloudCredentialOwner(connection, connection.apiBaseUrl)
      if (connection.credentialMode !== 'desktop_refresh' && !connection.token?.trim()) return
    } catch {
      return
    }
    // Each target owns its pending demand and failure guard. A parent's failure
    // must not prevent a running development instance from receiving the login.
    const resume = async () => {
      const results = await Promise.allSettled([
        recovery.python()?.then(runtime => {
          if (!recovery.isShuttingDown()) return runtime.resumeAfterLogin()
        }),
        recovery.development()?.resumePythonAfterLogin(),
      ])
      if (results.some(result => result.status === 'rejected'))
        console.warn('[python-runtime] Login-triggered preparation failed')
    }
    void resume()
  })
}
