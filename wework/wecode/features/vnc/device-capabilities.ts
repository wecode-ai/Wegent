import { isClaudeCodeDevice, supportsCloudSessions } from '@/lib/device-capabilities'

export function supportsVncDesktop(
  device: Parameters<typeof supportsCloudSessions>[0],
  deviceId?: string | null
): boolean {
  if (!isClaudeCodeDevice(device) || !supportsCloudSessions(device, deviceId)) return false
  const desktop = device.runtime_features?.desktop
  if (desktop == null) return true
  if (typeof desktop !== 'object' || Array.isArray(desktop)) return false
  const capability = desktop as Record<string, unknown>
  return (
    capability.protocol === 'rfb' &&
    capability.transport === 'websocket' &&
    capability.available !== false
  )
}
