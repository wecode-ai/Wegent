import type { RuntimeTaskAddress } from '@/types/api'

export function isPrimaryStandInConversation(
  task: Pick<RuntimeTaskAddress, 'taskId' | 'runtimeHandle'>
): boolean {
  const origin = task.runtimeHandle?.origin
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return false
  const identity = origin as Record<string, unknown>
  return (
    identity.type === 'stand_in_identity' &&
    identity.standInId == null &&
    typeof identity.userId === 'number' &&
    Number.isSafeInteger(identity.userId) &&
    identity.userId >= 0 &&
    task.taskId === `stand-in-chat-${identity.userId}-primary`
  )
}
