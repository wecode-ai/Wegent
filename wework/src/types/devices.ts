import type { DeviceSessionTransport, DeviceSessionType } from './device-sessions'

export interface DeviceInfo {
  id: number
  device_id: string
  name: string
  status: 'online' | 'offline' | 'busy'
  is_default: boolean
  device_type: 'local' | 'app' | 'cloud' | 'remote'
  bind_shell: 'claudecode' | 'openclaw'
  capabilities?: string[] | null
  slot_used?: number
  slot_max?: number
  running_tasks?: DeviceRunningTask[]
  running_task_ids?: number[]
  executor_version?: string | null
  latest_version?: string | null
  update_available?: boolean
  error?: string | null
  client_ip?: string | null
  runtime_transfer_host?: string | null
  runtime_instance_id?: string | null
  app_device_id?: string | null
  socket_device_id?: string | null
  runtime_routes?: Array<{
    kind: 'local-ipc' | 'cloud-relay' | 'remote-relay' | 'app-ipc'
    device_id: string
    runtime_device_id: string
    device_type?: string | null
    name?: string | null
    status: DeviceInfo['status']
  }>
  cloud_config?: {
    sandboxId?: string
    imageId?: string
    deviceId?: string
    deviceName?: string
    ubuntuInitialPassword?: string
    ubuntuPassword?: string
    createdAt?: string
  }
  remote_config?: {
    provider?: 'docker' | string
    image?: string
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

export interface DeviceRuntimeSettingsResponse {
  device_id: string
  max_concurrent_tasks: number
  active_tasks: number
  queued_tasks: number
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
  type: DeviceSessionType
  path: string
  url: string
  transport?: DeviceSessionTransport
  expires_at?: string | null
}

export interface CloudDeviceResponse {
  id: number
  device_id: string
  name: string
  status: string
  device_type: string
  message: string
}

export interface DockerRemoteDeviceCommandResponse {
  device_id: string
  name: string
  image: string
  env: Record<string, string>
  command: string
  commands?: RemoteDeviceStartupCommand[]
}

export interface RemoteDeviceStartupCommand {
  kind: 'docker' | 'process' | string
  label: string
  description?: string | null
  command: string
}

export interface CreateDockerRemoteDeviceCommandRequest {
  container_name?: string
  client_origin?: string
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
