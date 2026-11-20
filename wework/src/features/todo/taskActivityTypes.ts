import { type IssueAssignmentReceiptState } from './IssueAssignmentReceipts'

import {
  type HumanDispatchAssignment,
  type SharedIssueStatusHistoryEntry,
} from '@wegent/collaboration'
import type { CollaborationAgent, CollaborationMember } from '@wegent/collaboration'

import type { ProjectChatClient } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject, LoopItemTaskBinding } from '@/api/deliveries'

import type { createProjectChatAgentApi } from '@/api/projectChatAgents'
import type { ProjectWithTasks, RuntimeTaskAddress } from '@/types/api'

import type { RuntimePaneQueuedMessage } from '@/types/workbench'

import type { CloudProjectMember } from '@/api/deliveries'
export interface TaskActivityViewProps {
  commentActions?: import('@wegent/collaboration').CommentIssueActions
  assignmentReceipts?: IssueAssignmentReceiptState | null
  commentAssignment?: import('@wegent/collaboration').CommentAssignment
  client?: ProjectChatClient
  project: CloudProject
  task: CloudLoopItem
  currentUserId?: string | number
  onTaskRead?: (task: CloudLoopItem) => void
  onTaskUpdated?: (task: CloudLoopItem) => void
  projectChatAgentApi?: ReturnType<typeof createProjectChatAgentApi>
  localProjects?: ProjectWithTasks[]
  // When true, the chat client owns the AI execution lifecycle (local project
  // spaces enqueue a robot run inside send), so the shared runtime-task start
  // flow must not run again.
  selfManagedExecution?: boolean
  // rail mode: fill a fixed-height side column with an internally scrolling
  // message list and a composer pinned to the bottom
  rail?: boolean
  linear?: boolean
  deviceNamesById?: Readonly<Record<string, string>>
  taskBindings?: LoopItemTaskBinding[]
  statusHistory?: SharedIssueStatusHistoryEntry[]
  projectMembers?: CloudProjectMember[]
  issueTimeline?: boolean
  onOpenTask?: (task: LoopItemTaskBinding) => void
  /** Embedded hosts hand workspace-dependent execution details back to the task page. */
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => void
  onRefreshExecutionArtifacts?: () => void | Promise<void>
  /** Project members and robots that the comment composers can mention. */
  members?: CollaborationMember[]
  agents?: CollaborationAgent[]
  /** Opens the comment list on this comment and flashes it once. */
  focusedCommentId?: string | null
  /** Changes for each navigation request, including reopening the same comment. */
  focusedCommentRequestKey?: string | null
  /**
   * Opens a task for the member a manager assigned this Issue to. A reply on a
   * thread that has no execution to continue posts its comment and then asks
   * the host to start that work item.
   */
  onStartHumanTaskFromReply?: (input: StartHumanTaskFromReplyInput) => void | Promise<void>
}

export interface StartHumanTaskFromReplyInput {
  issueId: string
  dispatch: HumanDispatchAssignment
  replyText: string
}

export interface ActivityExecutionDetail {
  address: RuntimeTaskAddress
  messageId?: string
  senderName: string
  runId: string | null
  modelName: string | null
  runStatus: string | null
}

export type TaskCardQueuedReply = RuntimePaneQueuedMessage
export const EMPTY_STATUS_HISTORY: SharedIssueStatusHistoryEntry[] = []
