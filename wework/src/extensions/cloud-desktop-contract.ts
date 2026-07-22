import type { ComponentType } from 'react'

export interface CloudDesktopConnection {
  apiBaseUrl?: string
  isConnected: boolean
  socketBaseUrl?: string
  token: string | null
}

export interface CloudDesktopActionProps {
  deviceId: string
  disabled: boolean
  onOpened: () => void
}

export interface CloudDesktopWorkspaceActionProps {
  contextKey: string
  deviceId: string
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onErrorChange: (message: string | null) => void
  onOpened: () => void
  testIdsEnabled?: boolean
}

export type CloudDesktopOpenTarget = 'embedded' | 'system'

export interface OpenCloudDesktopOptions {
  connection: CloudDesktopConnection
  deviceId: string
  isCurrent: () => boolean
  target?: CloudDesktopOpenTarget
}

export interface CloudDesktopExtension {
  available: boolean
  DeviceAction: ComponentType<CloudDesktopActionProps>
  WorkspaceAction: ComponentType<CloudDesktopWorkspaceActionProps>
  isInternalPageUrl: (value: string) => boolean
  open: (options: OpenCloudDesktopOptions) => Promise<boolean>
}
