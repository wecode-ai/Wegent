import type { Attachment } from './runtime'
import type { ModelOptions } from './models'
import type {
  RuntimeAdditionalContext,
  RuntimeGoalCreateInput,
  RuntimeSendRequest,
} from './runtime-task-api-types'
import type { CodeCommentContext } from './code-comment'
import type { ProjectChatMention } from './project-chat'
export type QueuedMessageStatus = 'queued' | 'sending' | 'failed'
export type GuidanceMessageStatus = 'sending' | 'queued' | 'applied' | 'expired' | 'failed'

export interface QueuedWorkbenchMessage {
  id: string
  content: string
  status: QueuedMessageStatus
  runtimeQueued?: boolean
  runtimeQueuePosition?: number | null
  runtimeTurnIdsBeforeStart?: string[]
  deliveryMode?: 'message' | 'guidance'
  awaitingTurnStart?: boolean
  awaitingGuidanceAcceptance?: boolean
  createdAt: string
  error?: string
  notice?: string
}

export interface RuntimePaneQueuedMessage extends QueuedWorkbenchMessage {
  interactionId?: string
  attachments?: Attachment[]
  mentions?: ProjectChatMention[]
  displayContent?: string
  imageMarkupDraftText?: string
  codeComments?: CodeCommentContext[]
  modelId?: string
  modelType?: RuntimeSendRequest['modelType']
  modelOptions?: ModelOptions
  startNewSession?: RuntimeSendRequest['startNewSession']
  expectedThreadId?: RuntimeSendRequest['expectedThreadId']
  runtimeGoalRequest?: boolean
  initialGoal?: RuntimeGoalCreateInput
  additionalContext?: RuntimeAdditionalContext
  cloudProjectId?: RuntimeSendRequest['cloudProjectId']
  origin?: RuntimeSendRequest['origin']
  conversationContext?: RuntimeSendRequest['conversationContext']
  requestUserInputResponse?: RuntimeSendRequest['requestUserInputResponse']
}

export interface GuidanceWorkbenchMessage {
  id: string
  content: string
  status: GuidanceMessageStatus
  createdAt: string
  error?: string
}

export function canReorderQueuedMessage(message: QueuedWorkbenchMessage): boolean {
  return (
    message.status === 'queued' && !message.runtimeQueued && !message.awaitingGuidanceAcceptance
  )
}

export function reorderLocalQueuedMessages<Message extends QueuedWorkbenchMessage>(
  messages: Message[],
  sourceId: string,
  targetId: string
): Message[] {
  const local = messages.filter(canReorderQueuedMessage)
  const source = local.findIndex(message => message.id === sourceId)
  const target = local.findIndex(message => message.id === targetId)
  if (source < 0 || target < 0 || source === target) return messages
  const [moved] = local.splice(source, 1)
  local.splice(target, 0, moved)
  let next = 0
  return messages.map(message => (canReorderQueuedMessage(message) ? local[next++] : message))
}
