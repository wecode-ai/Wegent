import { requiresNewSessionForModelSwitch } from '@/features/workbench/modelSwitch'
import type { RuntimeTaskLifecycleSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import {
  appendConversationMentionContext,
  createConversationMentionReference,
} from '@/lib/conversation-mentions'
import type {
  RuntimeAdditionalContext,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  UnifiedModel,
} from '@/types/api'
import type { RuntimeTranscriptLoader } from '@/types/workbench'

export async function prepareModelSessionSwitch({
  address,
  lifecycle,
  activeModel,
  selectedModel,
  busy,
  blockedMessage,
  unresolvedMessage,
  additionalContext,
  loadTranscript,
}: {
  address: RuntimeTaskAddress
  lifecycle: RuntimeTaskLifecycleSnapshot | null
  activeModel: UnifiedModel | null | undefined
  selectedModel: UnifiedModel | null
  busy: boolean
  blockedMessage: string
  unresolvedMessage: string
  additionalContext?: RuntimeAdditionalContext
  loadTranscript: RuntimeTranscriptLoader
}): Promise<Pick<
  RuntimeSendRequest,
  'startNewSession' | 'expectedThreadId' | 'additionalContext'
> | null> {
  if (!requiresNewSessionForModelSwitch(activeModel, selectedModel)) return null
  if (busy || lifecycle?.interactionStatus || lifecycle?.goalStatus === 'active') {
    throw new Error(blockedMessage)
  }
  const expectedThreadId =
    lifecycle?.task?.threadId ?? lifecycle?.address.threadId ?? address.threadId
  if (!expectedThreadId) throw new Error(unresolvedMessage)
  const reference = createConversationMentionReference(lifecycle?.task?.title ?? address.taskId, {
    ...address,
    threadId: expectedThreadId,
  })
  return {
    startNewSession: true,
    expectedThreadId,
    additionalContext: await appendConversationMentionContext(
      reference,
      additionalContext,
      (target, options) => loadTranscript(target, { ...options, isolated: true })
    ),
  }
}
