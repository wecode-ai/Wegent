import { persistAttachmentReferences } from '@/lib/attachments'
import type { Attachment } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import type { CodeCommentContext } from '@/types/workspace-files'

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
