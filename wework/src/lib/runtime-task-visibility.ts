import type { RuntimeTaskAddress } from '@/types/api'
import { standInConversationTaskId } from '@/api/personalStandIn'

export function isStandInMemoryReviewTask(
  task: Pick<RuntimeTaskAddress, 'runtimeHandle'>
): boolean {
  const origin = task.runtimeHandle?.origin
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return false
  const identity = origin as Record<string, unknown>
  return identity.type === 'stand_in_schedule' && identity.memoryReview === true
}

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
    (identity.conversationScope == null || identity.conversationScope === 'collaboration') &&
    task.taskId ===
      standInConversationTaskId(
        identity.userId,
        undefined,
        identity.conversationScope === 'collaboration' ? 'collaboration' : undefined
      )
  )
}
