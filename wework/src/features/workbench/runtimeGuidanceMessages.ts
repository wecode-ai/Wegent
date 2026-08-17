import type { RuntimeGuidanceAppliedPayload } from '@/types/api'
import type { RuntimePaneQueuedMessage, WorkbenchMessage } from '@/types/workbench'
import { persistAttachmentReferences } from '@/lib/attachments'

export interface AppliedRuntimeGuidanceMessage extends WorkbenchMessage {
  role: 'user'
  status: 'done'
  createdAt: string
  runtimeGuidance: true
}

export function createOptimisticRuntimeGuidanceMessage(
  guidanceMessage: RuntimePaneQueuedMessage
): WorkbenchMessage & { role: 'user'; runtimeGuidance: true } {
  return {
    id: guidanceMessage.id,
    role: 'user',
    content: guidanceMessage.content,
    ...(guidanceMessage.attachments && {
      attachments: persistAttachmentReferences(guidanceMessage.attachments),
    }),
    status: 'pending',
    createdAt: guidanceMessage.createdAt,
    runtimeGuidance: true,
    ...(guidanceMessage.runtimeGoalRequest && { runtimeGoalRequest: true }),
    ...(guidanceMessage.codeComments?.length && { codeComments: guidanceMessage.codeComments }),
  }
}

export function createAppliedRuntimeGuidanceMessage(
  guidanceMessage: RuntimePaneQueuedMessage,
  payload: RuntimeGuidanceAppliedPayload
): AppliedRuntimeGuidanceMessage {
  const appliedAtMs = Number.isFinite(payload.appliedAtMs) ? payload.appliedAtMs : Date.now()

  return {
    id: guidanceMessage.id,
    role: 'user',
    content: guidanceMessage.content,
    ...(guidanceMessage.attachments && {
      attachments: persistAttachmentReferences(guidanceMessage.attachments),
    }),
    status: 'done',
    createdAt: new Date(appliedAtMs).toISOString(),
    runtimeGuidance: true,
    ...(guidanceMessage.runtimeGoalRequest && { runtimeGoalRequest: true }),
    ...(guidanceMessage.codeComments?.length && { codeComments: guidanceMessage.codeComments }),
  }
}
