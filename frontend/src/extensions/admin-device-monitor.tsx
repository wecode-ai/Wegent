import type { ReactNode } from 'react'
import type { AdminDeviceInfo } from '@/apis/admin'

export interface AdminDeviceMonitorExtension {
  supportsCloudDeviceDeletion: boolean
  renderAction: (device: AdminDeviceInfo) => ReactNode
  renderPanel: () => ReactNode
}

const emptyExtension: AdminDeviceMonitorExtension = {
  supportsCloudDeviceDeletion: false,
  renderAction: () => null,
  renderPanel: () => null,
}

export function useAdminDeviceMonitorExtension(
  _devices: AdminDeviceInfo[] = []
): AdminDeviceMonitorExtension {
  return emptyExtension
}
