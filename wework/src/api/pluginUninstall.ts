import type { InstalledPluginListResponse } from '@/types/api'
import { raceWithTimeout } from '@/lib/promise-timeout'
import { ApiError, type HttpClient } from './http'

export const PLUGIN_UNINSTALL_TIMEOUT_MS = 15_000
export const PLUGIN_UNINSTALL_CHECK_TIMEOUT_MS = 10_000

async function withDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController()
  try {
    return await raceWithTimeout(request(controller.signal), timeoutMs, () => {
      controller.abort()
      return new Error('Plugin uninstall request timed out')
    })
  } finally {
    controller.abort()
  }
}

/** Confirm ambiguous DELETE outcomes against account state, never a local/device cache. */
export async function uninstallCloudPlugin(
  client: HttpClient,
  id: string | number,
  deviceQuery: string
): Promise<void> {
  try {
    await withDeadline(
      signal => client.delete(`/plugins/installed/${id}${deviceQuery}`, undefined, { signal }),
      PLUGIN_UNINSTALL_TIMEOUT_MS
    )
    return
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 404
    ) {
      throw error
    }
  }

  try {
    // No device filter: a plugin missing on this device can still be installed on the account.
    const inventory = await withDeadline(
      signal => client.get<InstalledPluginListResponse>('/plugins/installed', { signal }),
      PLUGIN_UNINSTALL_CHECK_TIMEOUT_MS
    )
    const ids = inventory?.items?.map(plugin => {
      const labels = plugin.metadata?.labels
      return labels && typeof labels === 'object'
        ? (labels as Record<string, unknown>).id
        : undefined
    })
    if (
      Array.isArray(inventory?.items) &&
      ids?.every(pluginId => pluginId != null) &&
      !ids.some(pluginId => String(pluginId) === String(id))
    ) {
      return
    }
  } catch {
    // A failed read is not evidence of success. Leave the shared inventory unchanged.
  }
  throw new ApiError('PLUGIN_UNINSTALL_UNCONFIRMED', 408, 'PLUGIN_UNINSTALL_UNCONFIRMED')
}
