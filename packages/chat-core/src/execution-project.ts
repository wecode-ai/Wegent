import type { ModelSelectionConfig } from './runtime-stream-types'

export interface ProjectExecutionConfig {
  targetType: 'local' | 'cloud' | 'remote'
  deviceId?: string
}

export interface ProjectWorkspaceConfig {
  source: 'git' | 'local_path' | 'device_path'
  localPath?: string
  checkoutPath?: string
}

export interface ProjectGitConfig {
  url: string
  repo?: string | null
  repoId?: number | null
  domain?: string | null
  branch?: string | null
}

export interface ProjectConfig {
  mode?: 'workspace' | string
  path?: string
  device_id?: string
  execution?: ProjectExecutionConfig | null
  workspace?: ProjectWorkspaceConfig | null
  git?: ProjectGitConfig | null
  modelSelection?: ModelSelectionConfig | null
}

export interface DeviceInfo {
  id: number
  device_id: string
  name: string
  status: 'online' | 'offline' | 'busy'
  is_default: boolean
  device_type?: 'local' | 'app' | 'cloud' | 'remote' | string
  capabilities?: string[] | null
  slot_used?: number
  slot_max?: number
  running_tasks?: DeviceRunningTask[]
  running_task_ids?: number[]
  executor_version?: string | null
  latest_version?: string | null
  update_available?: boolean
  error?: string | null
  bind_shell?: 'claudecode' | 'openclaw' | string
  client_ip?: string | null
  runtime_transfer_host?: string | null
  app_device_id?: string | null
  socket_device_id?: string | null
  runtime_instance_id?: string | null
  runtime_routes?: DeviceRuntimeRoute[]
  runtime_features?: RuntimeFeatureSet | null
}

export interface DeviceRuntimeRoute {
  kind: DeviceRuntimeRouteKind
  device_id: string
  runtime_device_id: string
  device_type?: string | null
  name?: string | null
  status: DeviceInfo['status']
}

export interface DeviceRunningTask {
  task_id?: number
  subtask_id?: number
  title?: string
  status?: string
  created_at?: string
}

export interface ProjectTask {
  id: number
  task_id: number
  task_title?: string
  task_status?: string
  title?: string
  status?: string
  source?: string | null
  device_id?: string | null
  execution_workspace_source?: string | null
  execution_workspace_path?: string | null
  created_at?: string
  updated_at?: string
  task_type?: string
}

export interface ProjectWithTasks {
  id: number
  name: string
  description?: string | null
  color?: string | null
  client_origin?: string
  config?: ProjectConfig | null
  tasks?: ProjectTask[]
}

export interface RuntimeWorktreeCapability {
  version: number
  managed: boolean
  deferredPrepare: boolean
  snapshots: boolean
  restore: boolean
  preflight: boolean
  reconcile?: boolean
  persistentStorageVerified?: boolean
}

export interface RuntimeInteractiveSessionCapability {
  codeServer?: boolean
  terminal?: boolean
}

export interface RuntimeFeatureSet {
  schemaVersion: number
  interactiveSessions?: RuntimeInteractiveSessionCapability | null
  worktrees?: RuntimeWorktreeCapability | null
  [feature: string]: unknown
}

export type DeviceRuntimeRouteKind = 'local-ipc' | 'cloud-relay' | 'remote-relay' | 'app-ipc'
