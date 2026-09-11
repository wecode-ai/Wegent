import type { DeviceInfo } from '@/types/api'
import type { ExecutionTarget } from './events'

type TelemetryDevice = Pick<DeviceInfo, 'device_id' | 'device_type'>

export function telemetryExecutionTarget(
  deviceId: string,
  devices: readonly TelemetryDevice[]
): ExecutionTarget {
  const deviceType = devices.find(device => device.device_id === deviceId)?.device_type
  if (deviceType === 'local' || deviceType === 'app') return 'local'
  if (deviceType === 'cloud') return 'cloud'
  if (deviceType === 'remote') return 'remote'
  return deviceId === 'local-device' ? 'local' : 'unknown'
}
