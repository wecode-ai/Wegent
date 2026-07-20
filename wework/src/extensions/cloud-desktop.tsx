import type { CloudDesktopExtension } from './cloud-desktop-contract'

export const cloudDesktopExtension: CloudDesktopExtension = {
  available: false,
  DeviceAction: () => null,
  isInternalPageUrl: () => false,
  open: async () => {
    throw new Error('Cloud desktop extension is unavailable')
  },
}
