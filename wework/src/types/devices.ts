export interface DeviceInfo {
  id: number
  device_id: string
  name: string
  status: 'online' | 'offline' | 'busy'
  is_default: boolean
  device_type: 'local' | 'cloud'
  bind_shell: 'claudecode' | 'openclaw'
  executor_version?: string
  latest_version?: string
  update_available?: boolean
  cloud_config?: {
    sandboxId?: string
    imageId?: string
    deviceId?: string
    deviceName?: string
    createdAt?: string
  }
}

export interface DeviceListResponse {
  items: DeviceInfo[]
  total: number
}

export interface DeviceSessionResponse {
  session_id: string
  device_id: string
  type: string
  path: string
  url: string
}

export interface CloudDeviceResponse {
  id: number
  device_id: string
  name: string
  status: string
  device_type: string
  message: string
}
