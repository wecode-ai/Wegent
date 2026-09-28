import type { DeviceSurfaceExtension } from './device-surface-contract'

export const deviceSurfaceExtension: DeviceSurfaceExtension = {
  available: false,
  DeviceAction: () => null,
  WorkspaceAction: () => null,
  RoutePage: () => null,
  isInternalPageUrl: () => false,
  isIsolatedSurface: () => false,
  workspaceMenuItem: () => null,
  supportsDevice: () => false,
}
