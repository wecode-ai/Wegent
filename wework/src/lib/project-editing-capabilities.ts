import type { DeviceInfo } from '@/types/api'

export type ProjectPluginSupport = 'supported' | 'unsupported' | 'unknown'

export interface ProjectEditingCapabilities {
  multiRoots: boolean
  aiSettings: boolean
  defaultProjectSpace: boolean
  plugins: ProjectPluginSupport
}

/** Only these releases have verified field-preserving upsert contracts. */
export function projectEditingCapabilities(device: DeviceInfo | null): ProjectEditingCapabilities {
  const features = device?.runtime_features
  if (features && Object.prototype.hasOwnProperty.call(features, 'projectEditing')) {
    const editing = features.projectEditing
    return {
      multiRoots: editing?.multiRoots === true,
      aiSettings: editing?.aiSettings === true,
      defaultProjectSpace: editing?.defaultProjectSpace === true,
      plugins: editing?.plugins === true ? 'supported' : 'unsupported',
    }
  }
  if (device?.device_type === 'local' || device?.device_type === 'app') {
    return { multiRoots: true, aiSettings: true, defaultProjectSpace: true, plugins: 'supported' }
  }
  const version = device?.executor_version?.trim()
  const multiRoots = version === '1.8.5' || version === '1.8.6' || version === '2.0.21'
  const aiSettings = version === '1.8.6' || version === '2.0.21'
  return { multiRoots, aiSettings, defaultProjectSpace: aiSettings, plugins: 'unknown' }
}

/** Inventory knowledge belongs to one connected runtime lifecycle. */
export function projectEditingDeviceRevision(device: DeviceInfo | null): string {
  const status = device?.status
  const availability = status === 'online' || status === 'busy' ? 'connected' : status
  return JSON.stringify([
    device?.device_id,
    device?.runtime_instance_id,
    device?.executor_version,
    availability,
    device?.runtime_features?.projectEditing,
  ])
}
