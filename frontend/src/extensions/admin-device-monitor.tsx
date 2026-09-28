import type { ReactNode } from 'react'
import type { AdminDeviceInfo } from '@/apis/admin'

export interface AdminDeviceMonitorExtension {
  renderAction: (device: AdminDeviceInfo) => ReactNode
  renderPanel: () => ReactNode
}

const emptyExtension: AdminDeviceMonitorExtension = {
  renderAction: () => null,
  renderPanel: () => null,
}

export function useAdminDeviceMonitorExtension(
  _devices: AdminDeviceInfo[] = []
): AdminDeviceMonitorExtension {
  return emptyExtension
}
