import { Monitor } from 'lucide-react'

import type { DeviceSurfaceExtension } from '@/extensions/device-surface-contract'
import i18n from '@/i18n'
import { supportsCloudSessions } from '@/lib/device-capabilities'
import { VncDesktopButton } from '@wecode/features/vnc/VncDesktopButton'
import { WorkspaceDesktopAction } from '@wecode/features/vnc/WorkspaceDesktopAction'
import { isInternalVncPageUrl } from '@wecode/features/vnc/session'

export const deviceSurfaceExtension: DeviceSurfaceExtension = {
  available: true,
  DeviceAction: VncDesktopButton,
  WorkspaceAction: WorkspaceDesktopAction,
  // The VNC viewer is a loopback page hosted in the embedded browser rather
  // than an application route, so no route page is contributed.
  RoutePage: () => null,
  isInternalPageUrl: isInternalVncPageUrl,
  isIsolatedSurface: () => false,
  workspaceMenuItem: language => ({
    id: 'desktop',
    label: i18n.getFixedT(language, 'vnc')('desktop'),
    icon: Monitor,
    testId: 'workspace-add-desktop-option',
  }),
  supportsDevice: (device, deviceId) => supportsCloudSessions(device, deviceId),
}
