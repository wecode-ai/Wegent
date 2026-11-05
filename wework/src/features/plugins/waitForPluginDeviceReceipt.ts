import { createRequestCache } from '@wegent/chat-core/request-cache'
import type { InstalledPlugin, InstalledPluginListResponse } from '@/types/api'
import { localPluginId } from '@/components/plugins/installedPluginMerge'
import { raceWithTimeout } from '@/lib/promise-timeout'
import { ApiError } from '@/api/http'

type ReadInstalled = (deviceId: string) => Promise<InstalledPluginListResponse>
const readers = new WeakMap<ReadInstalled, ReturnType<typeof createRequestCache>>()

export class PluginDeviceReceiptError extends Error {
  readonly code: string = 'PLUGIN_DEVICE_RECEIPT_UNCONFIRMED'
  constructor(cause?: unknown) {
    super('Plugin installation was saved, but the latest device receipt was not confirmed', {
      cause,
    })
  }
}

export class PluginDeviceReceiptTimeoutError extends PluginDeviceReceiptError {
  readonly code = 'PLUGIN_DEVICE_SYNC_TIMEOUT'
}

export class PluginInstallationSupersededError extends Error {
  readonly code = 'PLUGIN_INSTALL_SUPERSEDED'
  constructor() {
    super('Plugin installation scope or account intent changed')
  }
}

export function pluginDeviceReceiptPending(plugin: InstalledPlugin, deviceId: string): boolean {
  const receipt = plugin.status.devices?.find(item => item.deviceId === deviceId)
  if (receipt?.state === 'failed') return false
  if (receipt?.state !== 'installed') return true
  const release = plugin.spec.releaseId
  return (
    typeof release === 'number' &&
    (receipt.desiredReleaseId !== release || receipt.actualReleaseId !== release)
  )
}

function readLatest(read: ReadInstalled, deviceId: string, timeoutMs: number) {
  let cache = readers.get(read)
  if (!cache) {
    cache = createRequestCache()
    readers.set(read, cache)
  }
  // The API function owns account credentials. Share only concurrent reads on
  // that API/device; completed results must never confirm another receipt.
  const shared = cache.get(
    deviceId,
    () => raceWithTimeout(read(deviceId), 15_000, () => new PluginDeviceReceiptTimeoutError()),
    0
  )
  // Each waiter owns its remaining budget; timing out must not cancel peers.
  return raceWithTimeout(shared, timeoutMs, () => new PluginDeviceReceiptTimeoutError())
}

function retryableReceiptRead(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  return error instanceof TypeError || error instanceof PluginDeviceReceiptTimeoutError
}

export async function waitForPluginDeviceReceipt(
  initial: InstalledPlugin,
  deviceId: string,
  options: {
    readInstalled: ReadInstalled
    isCurrent: () => boolean
    timeoutMs?: number
    maxAttempts?: number
    wait?: (delayMs: number) => Promise<void>
  }
): Promise<InstalledPlugin> {
  const identity = localPluginId(initial)
  if (identity === null) throw new PluginInstallationSupersededError()
  const deadline = Date.now() + (options.timeoutMs ?? 60_000)
  const wait = options.wait ?? (delay => new Promise(resolve => window.setTimeout(resolve, delay)))
  let plugin = initial
  let lastReadError: unknown
  for (let attempt = 0; attempt < (options.maxAttempts ?? 15); attempt += 1) {
    if (!options.isCurrent()) throw new PluginInstallationSupersededError()
    if (!pluginDeviceReceiptPending(plugin, deviceId)) return plugin
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    if (attempt > 0) await wait(Math.min(1000 * 2 ** (attempt - 1), 5000, remaining))
    if (!options.isCurrent()) throw new PluginInstallationSupersededError()
    if (Date.now() >= deadline) break
    let response: InstalledPluginListResponse
    try {
      response = await readLatest(options.readInstalled, deviceId, deadline - Date.now())
    } catch (error) {
      // The install is already committed. Only retry reads within this poll's
      // original budget; never turn a receipt failure into an install rollback.
      if (!options.isCurrent()) throw new PluginInstallationSupersededError()
      if (!retryableReceiptRead(error)) throw new PluginDeviceReceiptError(error)
      lastReadError = error
      continue
    }
    if (!options.isCurrent()) throw new PluginInstallationSupersededError()
    const latest = response.items.find(item => localPluginId(item) === identity)
    if (!latest) throw new PluginInstallationSupersededError()
    plugin = latest
  }
  if (!options.isCurrent()) throw new PluginInstallationSupersededError()
  if (!pluginDeviceReceiptPending(plugin, deviceId)) return plugin
  throw new PluginDeviceReceiptTimeoutError(lastReadError)
}
