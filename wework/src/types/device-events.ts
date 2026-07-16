export interface DeviceSlotUpdatePayload {
  device_id: string
  slot_used: number
  slot_max?: number
  running_tasks?: DeviceRunningTaskPayload[]
  running_task_ids?: number[]
}

export interface DeviceRunningTaskPayload {
  task_id?: number
  subtask_id?: number
  title?: string
  status?: string
  created_at?: string
}

export type DeviceUpgradeStatus =
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'restarting'
  | 'success'
  | 'error'
  | 'skipped'
  | 'busy'

export interface DeviceUpgradeStatusPayload {
  device_id: string
  status: DeviceUpgradeStatus
  message?: string
  old_version?: string
  new_version?: string
  progress?: number
  error?: string
}

export interface DeviceUpgradeState {
  status: DeviceUpgradeStatus | 'pending'
  message: string
  progress?: number
  error?: string
}
