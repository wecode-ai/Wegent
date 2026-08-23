import {
  localConnectorAuthHealth,
  type LocalConnectorAuthResult,
  type LocalConnectorAuthTarget,
} from '@/api/local/localConnectorAuth'

const DEFAULT_MAX_ATTEMPTS = 31
const DEFAULT_RETRY_INTERVAL_MS = 1_000

type HealthProbe = (target: LocalConnectorAuthTarget) => Promise<LocalConnectorAuthResult>
type Wait = (delayMs: number) => Promise<void>

interface WaitForLocalConnectorAuthAvailabilityOptions {
  maxAttempts?: number
  retryIntervalMs?: number
  probe?: HealthProbe
  wait?: Wait
}

export class LocalConnectorPluginSyncTimeoutError extends Error {
  readonly code = 'PLUGIN_LOCAL_SYNC_TIMEOUT'

  constructor(pluginKey: string) {
    super(`Installed plugin '${pluginKey}' did not become available on this device`)
    this.name = 'LocalConnectorPluginSyncTimeoutError'
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isLocalConnectorPluginUnavailableError(error: unknown): boolean {
  return /(?:^|\b)plugin_not_installed(?:\b|:)/i.test(errorText(error))
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, delayMs))
}

export async function waitForLocalConnectorAuthAvailability(
  target: LocalConnectorAuthTarget,
  options: WaitForLocalConnectorAuthAvailabilityOptions = {}
): Promise<LocalConnectorAuthResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const retryIntervalMs = Math.max(0, options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS)
  const probe =
    options.probe ??
    ((currentTarget: LocalConnectorAuthTarget) =>
      localConnectorAuthHealth(currentTarget, { bypassCache: true }))
  const wait = options.wait ?? waitForDelay

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await probe(target)
    } catch (error) {
      if (!isLocalConnectorPluginUnavailableError(error)) throw error
      if (attempt === maxAttempts) {
        throw new LocalConnectorPluginSyncTimeoutError(target.pluginKey)
      }
      await wait(retryIntervalMs)
    }
  }

  throw new LocalConnectorPluginSyncTimeoutError(target.pluginKey)
}
