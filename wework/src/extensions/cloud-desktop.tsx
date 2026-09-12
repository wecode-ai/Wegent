import { DEVICE_DESKTOP_PATH } from '@/pages/deviceDesktopRoute'
import type { CloudDesktopExtension } from './cloud-desktop-contract'
import { CloudDesktopDeviceAction, CloudDesktopWorkspaceAction } from './cloud-desktop-actions'

export const cloudDesktopExtension: CloudDesktopExtension = {
  available: true,
  DeviceAction: CloudDesktopDeviceAction,
  WorkspaceAction: CloudDesktopWorkspaceAction,
  isInternalPageUrl: value => {
    try {
      return new URL(value, window.location.origin).pathname === DEVICE_DESKTOP_PATH
    } catch {
      return false
    }
  },
}
