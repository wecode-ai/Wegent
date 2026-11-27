import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  getRuntimeConversationQueueDiagnosticSnapshotByKey,
  runtimeConversationKey,
} from './runtimeConversationCache'

export function logRuntimeQueueStage(
  address: RuntimeTaskAddress,
  stage: string,
  details: Record<string, unknown> = {},
  snapshot?: ReturnType<typeof getRuntimeConversationQueueDiagnosticSnapshotByKey>
): void {
  const conversationKey = runtimeConversationKey(address)
  const queueSnapshot =
    snapshot ??
    getRuntimeConversationQueueDiagnosticSnapshotByKey(
      conversationKey,
      typeof details.messageId === 'string' ? details.messageId : undefined
    )
  logRuntimeTaskCreateStage(stage, {
    deviceId: address.deviceId,
    taskId: address.taskId,
    conversationKey,
    ...queueSnapshot,
    ...details,
  })
}

export function runtimeMessagePresentationDiagnostic(content: string | null | undefined) {
  return {
    contentLength: content?.length ?? 0,
    folderSchemeCount: content ? content.split('folder://').length - 1 : 0,
    fileSchemeCount: content ? content.split('file://').length - 1 : 0,
  }
}
