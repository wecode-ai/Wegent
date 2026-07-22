import type { CloudDesktopExtension } from '@/extensions/cloud-desktop-contract'
import { VncDesktopButton } from '@wecode/features/vnc/VncDesktopButton'
import { WorkspaceDesktopAction } from '@wecode/features/vnc/WorkspaceDesktopAction'
import { isInternalVncPageUrl } from '@wecode/features/vnc/session'

export const cloudDesktopExtension: CloudDesktopExtension = {
  available: true,
  DeviceAction: VncDesktopButton,
  WorkspaceAction: WorkspaceDesktopAction,
  isInternalPageUrl: isInternalVncPageUrl,
}
