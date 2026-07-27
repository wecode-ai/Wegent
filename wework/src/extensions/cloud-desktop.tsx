import type { CloudDesktopExtension } from './cloud-desktop-contract'

export const cloudDesktopExtension: CloudDesktopExtension = {
  available: false,
  DeviceAction: () => null,
  WorkspaceAction: () => null,
  isInternalPageUrl: () => false,
}
