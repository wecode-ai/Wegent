import type { LoopItemTaskBinding } from '@/api/deliveries'
import type { RuntimeTaskAddress } from '@/types/api'

export function runtimeTaskBindingAddress(
  binding: Pick<LoopItemTaskBinding, 'device_id' | 'task_id' | 'modelSelection'>
): RuntimeTaskAddress {
  return {
    deviceId: binding.device_id,
    taskId: binding.task_id,
    ...(binding.modelSelection
      ? { runtimeHandle: { modelSelection: binding.modelSelection } }
      : {}),
  }
}
