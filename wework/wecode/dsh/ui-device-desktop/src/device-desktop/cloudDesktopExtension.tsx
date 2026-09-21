import { Monitor } from 'lucide-react'
import type { DeviceSurfaceExtension } from '@/extensions/device-surface-contract'
import i18n from '@/i18n'
import {
  DEVICE_DESKTOP_PATH,
  isDeviceDesktopInternalPageUrl,
  isIsolatedDeviceDesktopSurface,
} from '@wecode/features/vnc/deviceDesktopRoute'
import { supportsVncDesktop } from '@wecode/features/vnc/device-capabilities'
import { CloudDesktopDeviceAction, CloudDesktopWorkspaceAction } from './CloudDesktopActions'
import DeviceDesktopPage from './DeviceDesktopPage'

export const deviceSurfaceExtension: DeviceSurfaceExtension = {
  available: true,
  DeviceAction: CloudDesktopDeviceAction,
  WorkspaceAction: CloudDesktopWorkspaceAction,
  RoutePage: DeviceDesktopPage,
  isInternalPageUrl: isDeviceDesktopInternalPageUrl,
  isIsolatedSurface: (path, search) =>
    path === DEVICE_DESKTOP_PATH && isIsolatedDeviceDesktopSurface(search),
  workspaceMenuItem: language => ({
    id: 'desktop',
    label: i18n.t('vnc:desktop', { lng: language }),
    icon: Monitor,
    testId: 'workspace-add-desktop-option',
    telemetryPanel: 'desktop',
  }),
  supportsDevice: supportsVncDesktop,
}
