import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  getRuntimeConversationQueueDiagnosticSnapshotByKey,
  runtimeConversationKey,
} from './runtimeConversationCache'

export function logRuntimeQueueStage(
  address: RuntimeTaskAddress,
  stage: string,
  details: Record<string, unknown> = {}
): void {
  const conversationKey = runtimeConversationKey(address)
  logRuntimeTaskCreateStage(stage, {
    deviceId: address.deviceId,
    taskId: address.taskId,
    conversationKey,
    ...getRuntimeConversationQueueDiagnosticSnapshotByKey(
      conversationKey,
      typeof details.messageId === 'string' ? details.messageId : undefined
    ),
    ...details,
  })
}
