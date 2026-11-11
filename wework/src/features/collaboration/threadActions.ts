import type {
  CollaborationIssue,
  CollaborationProject,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { ChatGroup, ThreadParticipation } from '@/api/chatGroups'

export interface ThreadActionContext {
  group: ChatGroup
  project: CollaborationProject
  item: CollaborationIssue
  api: SharedWorkspaceApi
  participation: ThreadParticipation | null
  accountScope: string
  sourceStore: 'local' | 'cloud'
  requestLeave(action: () => void): void
}

export type ThreadArchivePreparationContext = Pick<
  ThreadActionContext,
  'item' | 'api' | 'sourceStore'
>
