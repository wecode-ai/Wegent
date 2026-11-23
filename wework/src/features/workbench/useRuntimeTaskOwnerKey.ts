import { useState } from 'react'
import { runtimeTasksShareOwner } from '@/lib/workbench-device'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'

/** UI ownership survives a proven alias replacement; transport still uses the current address. */
export function useRuntimeTaskOwnerKey(task: RuntimeTaskAddress | null, devices: DeviceInfo[]) {
  const addressKey = task ? `task:${task.deviceId}:${task.taskId}` : null
  const [owner, setOwner] = useState({ task, addressKey, key: addressKey })
  if (owner.addressKey !== addressKey) {
    const key = runtimeTasksShareOwner(owner.task, task, devices) ? owner.key : addressKey
    setOwner({ task, addressKey, key })
    return key
  }
  return owner.key
}
