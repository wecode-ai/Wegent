import type { CloudDesktopExtension } from '@/extensions/cloud-desktop-contract'
import { VncDesktopButton } from '@wecode/features/vnc/VncDesktopButton'
import { openCloudDesktop } from '@wecode/features/vnc/openCloudDesktop'
import { isInternalVncPageUrl } from '@wecode/features/vnc/session'

export const cloudDesktopExtension: CloudDesktopExtension = {
  available: true,
  DeviceAction: VncDesktopButton,
  isInternalPageUrl: isInternalVncPageUrl,
  open: openCloudDesktop,
}
