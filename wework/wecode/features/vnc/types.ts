export interface CloudDesktopConnection {
  apiBaseUrl?: string
  isConnected: boolean
  socketBaseUrl?: string
  token: string | null
}

export type CloudDesktopOpenTarget = 'embedded' | 'system'

export interface OpenCloudDesktopOptions {
  connection: CloudDesktopConnection
  deviceId: string
  isCurrent: () => boolean
  target?: CloudDesktopOpenTarget
}
