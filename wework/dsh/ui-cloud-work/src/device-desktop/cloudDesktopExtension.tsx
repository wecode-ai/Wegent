import type { CloudDesktopExtension } from '@/extensions/cloud-desktop-contract'
import { isDeviceDesktopInternalPageUrl } from '@/pages/deviceDesktopRoute'
import { CloudDesktopDeviceAction, CloudDesktopWorkspaceAction } from './CloudDesktopActions'

export const cloudDesktopExtension: CloudDesktopExtension = {
  available: true,
  DeviceAction: CloudDesktopDeviceAction,
  WorkspaceAction: CloudDesktopWorkspaceAction,
  isInternalPageUrl: isDeviceDesktopInternalPageUrl,
}
