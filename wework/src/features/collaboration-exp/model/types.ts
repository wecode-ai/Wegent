import type { ProjectChatMessage } from '@wegent/chat-core'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import type {
  CollaborationIssue,
  CollaborationAssignment,
  CollaborationProject,
  IssueParticipationViewer,
  WorkspaceMyWorkItem,
  WorkspaceTaskBinding,
  WorkspaceIssueCollaborator,
} from '@wegent/collaboration'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInInboxWork, StandInProposal } from '@/api/standIn'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'

export type ExperienceSourceState = 'ready' | 'unknown' | 'hidden'

export interface ExperienceProjectScope {
  key: string
  id: string
  store: CollaborationProject['project_store']
  name: string
  projectKey: string
}

export type ExperienceIssueSource = CollaborationIssue &
  Partial<Pick<WorkspaceMyWorkItem, 'task_bindings'>>

export interface ExperienceProjectData {
  project: CollaborationProject
  issues: readonly ExperienceIssueSource[]
  taskBindings?: readonly WorkspaceTaskBinding[]
  collaborators?: readonly WorkspaceIssueCollaborator[]
}

export interface ExperienceReadModelInput {
  projects: readonly ExperienceProjectData[]
  viewer: IssueParticipationViewer
  runtimeWork?: RuntimeWorkListResponse | null
}

export interface ExperiencePrivateConversation {
  issueSource?: {
    projectStore: CollaborationProject['project_store']
    projectId: string
    issueId: string
  }
  key: string
  bindingIds: string[]
  ownerUserId: number
  address: RuntimeTaskAddress
  title: string | null
  linkedAt: string | null
  sourceNodeIds: string[]
  historySource?: {
    turnId: string | null
    userMessageIds: string[]
  }
}

export interface ExperienceConversationSelection {
  state: ExperienceSourceState
  items: ExperiencePrivateConversation[]
}

export interface ExperienceTaskRow {
  key: string
  id: string
  project: ExperienceProjectScope
  title: string
  status: string
  statusName: string
  priority: CollaborationIssue['priority']
  assignee: { id: number; name: string | null } | null
  needsUser: boolean
  waitingSince: string | null
  waitingFor: { id: number; name: string }[]
  executionState: string | null
  completedAt?: string | null
  updatedAt: string
  conversations: ExperienceConversationSelection
}

export interface ExperienceTaskFilter {
  relevance?: 'related' | 'all'
  projectKey?: string | null
  statuses?: readonly string[]
  search?: string
}

export interface ExperienceProjectSummary extends ExperienceProjectScope {
  taskCount: number
  needsUserCount: number
}

export interface ExperienceTimelineInput {
  project: CollaborationProject
  issue: CollaborationIssue | null | undefined
  viewer: IssueParticipationViewer
  messages: readonly ProjectChatMessage[] | null | undefined
  taskBindings?: readonly WorkspaceTaskBinding[]
  runtimeWork?: RuntimeWorkListResponse | null
  assignments?: readonly CollaborationAssignment[] | null
}

export interface ExperienceAttachmentReference {
  id: string
  name: string
  sourceNodeId: string
}

export interface ExperienceTimelineNode {
  id: string
  clientMessageId?: string | null
  sequenceNumber: number | null
  kind: 'comment' | 'execution' | 'system' | 'handoff' | 'status'
  at: string | null
  body: string | null
  author: { id: string; name: string | null } | null
  status: ProjectChatMessage['status']
  attachments: ExperienceAttachmentReference[]
  conversation: ExperienceConversationSelection
  executionAddress: RuntimeTaskAddress | null
  transition?: { from: string; to: string }
  handoff?: {
    action: 'assign' | 'reassign' | 'unassign'
    targetType: string | null
    targetId: string | null
    targetName: string | null
  }
}

export interface ExperienceTimeline {
  state: ExperienceSourceState
  nodes: ExperienceTimelineNode[]
}

export interface ExperienceAssistantInput {
  viewer: IssueParticipationViewer
  settings: PersonalStandInSettings | null | undefined
  proposals?: readonly StandInProposal[]
  inbox?: readonly StandInInboxWork[]
  conversations?: readonly ExperiencePrivateConversation[]
}

export interface ExperienceAssistantSummary {
  state: ExperienceSourceState
  roles: { id: string | null; name: string | null; enabled: boolean; isDefault: boolean }[]
  pendingDecisions: { id: string; summary: string; roleId: string | null }[]
  recentDiscussions: ExperiencePrivateConversation[]
  work: {
    id: string
    taskId: string
    roleId: string
    title: string
    status: StandInInboxWork['status']
  }[]
}

export type ExperienceWorkState = 'waiting' | 'running' | 'completed' | 'idle'

export interface ExperienceWorkCounts {
  waiting: number
  running: number
  completed: number
}

export interface ExperienceWorkSnapshotItem {
  key: string
  title: string
  state: ExperienceWorkState
  roleIds: (string | null)[]
  updatedAt: string
  taskRow?: ExperienceTaskRow
  address?: RuntimeTaskAddress
}

export interface ExperienceTeamRelayNode {
  id: string | null
  name: string | null
  enabled: boolean
  isDefault: boolean
  state: 'waiting' | 'running' | 'idle'
  counts: ExperienceWorkCounts
}

export interface ExperienceWorkSnapshotInput {
  roles: ExperienceAssistantSummary['roles']
  work: readonly RuntimeTaskReminderItem[]
  pendingDecisions?: readonly ExperienceAssistantSummary['pendingDecisions'][number][]
  /** Already authorized and filtered visible Issue rows; omitted on the assistant home. */
  rows?: readonly ExperienceTaskRow[]
}

export interface ExperienceWorkSnapshot {
  counts: ExperienceWorkCounts
  current: ExperienceWorkSnapshotItem | null
  items: ExperienceWorkSnapshotItem[]
  team: ExperienceTeamRelayNode[]
}
