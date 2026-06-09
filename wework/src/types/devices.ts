export interface DeviceInfo {
  id: number
  device_id: string
  name: string
  status: 'online' | 'offline' | 'busy'
  is_default: boolean
  device_type: 'local' | 'cloud'
  bind_shell: 'claudecode' | 'openclaw'
  capabilities?: string[] | null
  slot_used?: number
  slot_max?: number
  running_tasks?: DeviceRunningTask[]
  running_task_ids?: number[]
  executor_version?: string | null
  latest_version?: string | null
  update_available?: boolean
  cloud_config?: {
    sandboxId?: string
    imageId?: string
    deviceId?: string
    deviceName?: string
    createdAt?: string
  }
}

export interface DeviceRunningTask {
  task_id?: number
  subtask_id?: number
  title?: string
  status?: string
  created_at?: string
}

export interface DeviceListResponse {
  items: DeviceInfo[]
  total: number
}

export interface UpgradeDeviceOptions {
  force?: boolean
  auto_confirm?: boolean
  verbose?: boolean
  force_stop_tasks?: boolean
  registry?: string
  registry_token?: string
}

export interface UpgradeDeviceResponse {
  success: boolean
  message: string
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

export interface CloudDeviceMetricsResponse {
  cpu_usage: number | null
  memory_usage: number | null
  disk_usage: number | null
}

export interface MetricsHistoryResponse {
  cpu: [number, number][]
  memory: [number, number][]
  disk: [number, number][]
}

export interface VncConfigResponse {
  wss_url: string
  signature: string
  sandbox_id: string
}
