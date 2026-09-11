import type { InstalledPlugin } from '@/types/api'
import { trackPluginEvent } from '@/telemetry/businessEvents'
import { beginOperation, type OperationAttempt } from '@/telemetry/operationBus'

interface PendingInstallation {
  attempt: OperationAttempt
  deviceId: string
  releaseId: number | null
}

const pending = new Map<string, PendingInstallation>()

function installationKey(plugin: InstalledPlugin, deviceId: string): string | null {
  const labels = plugin.metadata.labels as { id?: string | number } | undefined
  return labels?.id == null ? null : `${deviceId}:${String(labels.id)}`
}

export function recordPluginInstallationAccepted(
  plugin: InstalledPlugin,
  deviceId: string,
  source: 'local' | 'cloud'
): void {
  if (source === 'local') {
    trackPluginEvent('plugin_installed', { source })
    beginOperation('plugin.device_install').succeed()
    return
  }
  const key = installationKey(plugin, deviceId)
  if (key === null) return
  pending.get(key)?.attempt.cancel()
  pending.set(key, {
    attempt: beginOperation('plugin.device_install'),
    deviceId,
    releaseId: plugin.spec.releaseId ?? null,
  })
  if (pending.size > 100) {
    const oldest = pending.keys().next().value!
    pending.get(oldest)?.attempt.cancel()
    pending.delete(oldest)
  }
  reconcilePluginInstallation(plugin, deviceId)
}

export function reconcilePluginInstallation(plugin: InstalledPlugin, deviceId: string): void {
  const key = installationKey(plugin, deviceId)
  if (key === null) return
  const entry = pending.get(key)
  if (!entry) return
  const device = plugin.status.devices?.find(item => item.deviceId === entry.deviceId)
  if (!device || (entry.releaseId !== null && device.desiredReleaseId !== entry.releaseId)) return
  if (device.state === 'failed') {
    entry.attempt.fail('confirm')
    pending.delete(key)
  } else if (device.state === 'installed' && device.actualReleaseId === device.desiredReleaseId) {
    entry.attempt.succeed()
    trackPluginEvent('plugin_installed', { source: 'cloud' })
    pending.delete(key)
  }
}
