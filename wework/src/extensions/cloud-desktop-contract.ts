import type { ComponentType } from 'react'

export interface CloudDesktopActionProps {
  deviceId: string
  disabled: boolean
  onOpened: () => void
}

export interface CloudDesktopLaunchOptions {
  notifyOpened?: boolean
}

export type CloudDesktopLaunchAction = (options?: CloudDesktopLaunchOptions) => Promise<void>

export interface CloudDesktopWorkspaceActionProps {
  contextKey: string
  deviceId: string
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onErrorChange: (message: string | null) => void
  onLaunchActionChange?: (action: CloudDesktopLaunchAction | null) => void
  onOpened: () => void
  testIdsEnabled?: boolean
}

export interface CloudDesktopExtension {
  available: boolean
  DeviceAction: ComponentType<CloudDesktopActionProps>
  WorkspaceAction: ComponentType<CloudDesktopWorkspaceActionProps>
  isInternalPageUrl: (value: string) => boolean
}
