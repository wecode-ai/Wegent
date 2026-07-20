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

export interface OpenCloudDesktopOptions {
  connection: CloudDesktopConnection
  deviceId: string
  isCurrent: () => boolean
}

export interface CloudDesktopExtension {
  available: boolean
  DeviceAction: ComponentType<CloudDesktopActionProps>
  isInternalPageUrl: (value: string) => boolean
  open: (options: OpenCloudDesktopOptions) => Promise<boolean>
}
