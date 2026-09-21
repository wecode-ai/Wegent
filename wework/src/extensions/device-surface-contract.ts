import type { ComponentType } from 'react'
import type { DeviceInfo } from '@/types/api'
import type { AnalyticsEventMap } from '@/telemetry/events'

export interface DeviceSurfaceActionProps {
  deviceId: string
  disabled: boolean
  onOpened: () => void
}

export interface DeviceSurfaceLaunchOptions {
  notifyOpened?: boolean
}

export type DeviceSurfaceLaunchAction = (options?: DeviceSurfaceLaunchOptions) => Promise<void>

export interface DeviceSurfaceWorkspaceActionProps {
  contextKey: string
  deviceId: string
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onErrorChange: (message: string | null) => void
  onLaunchActionChange?: (action: DeviceSurfaceLaunchAction | null) => void
  onOpened: () => void
  testIdsEnabled?: boolean
}

export interface DeviceSurfaceWorkspaceMenuItem {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  testId?: string
  telemetryPanel?: AnalyticsEventMap['workspace_panel_added']['panel']
}

export interface DeviceSurfaceExtension {
  available: boolean
  DeviceAction: ComponentType<DeviceSurfaceActionProps>
  WorkspaceAction: ComponentType<DeviceSurfaceWorkspaceActionProps>
  RoutePage: ComponentType<{ search?: string }>
  isInternalPageUrl: (value: string) => boolean
  isIsolatedSurface: (path: string, search: string) => boolean
  workspaceMenuItem: (language: string) => DeviceSurfaceWorkspaceMenuItem | null
  supportsDevice: (device: DeviceInfo, deviceId?: string | null) => boolean
}
