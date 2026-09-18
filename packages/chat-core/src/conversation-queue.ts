import type { Attachment } from './runtime'
import type { ModelOptions } from './models'
import type {
  RuntimeAdditionalContext,
  RuntimeGoalCreateInput,
  RuntimeSendRequest,
} from './runtime-task-api-types'
import type { CodeCommentContext } from './code-comment'
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
  attachments?: Attachment[]
  displayContent?: string
  codeComments?: CodeCommentContext[]
  modelId?: string
  modelType?: RuntimeSendRequest['modelType']
  modelOptions?: ModelOptions
  runtimeGoalRequest?: boolean
  initialGoal?: RuntimeGoalCreateInput
  additionalContext?: RuntimeAdditionalContext
}

export interface GuidanceWorkbenchMessage {
  id: string
  content: string
  status: GuidanceMessageStatus
  createdAt: string
  error?: string
}
