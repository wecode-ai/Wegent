import { persistAttachmentReferences } from '../composer/attachmentFiles'
import type { Attachment } from '@wegent/chat-core/runtime'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { CodeCommentContext } from '@wegent/chat-core/code-comment'

export interface RuntimeUserMessageOptions {
  id?: string
  createdAt?: string
  runtimeGoalRequest?: boolean
  runtimeGuidance?: boolean
  codeComments?: CodeCommentContext[]
}

export function createRuntimeUserMessage(
  content: string,
  attachments?: Attachment[],
  options: RuntimeUserMessageOptions = {}
): WorkbenchMessage & { role: 'user' } {
  return {
    id: options.id ?? `runtime-local-pane-${Date.now()}`,
    role: 'user',
    content,
    attachments: attachments ? persistAttachmentReferences(attachments) : undefined,
    status: 'done',
    createdAt: options.createdAt ?? new Date().toISOString(),
    runtimeGoalRequest: options.runtimeGoalRequest ? true : undefined,
    runtimeGuidance: options.runtimeGuidance ? true : undefined,
    codeComments: options.codeComments?.length ? options.codeComments : undefined,
  }
}
