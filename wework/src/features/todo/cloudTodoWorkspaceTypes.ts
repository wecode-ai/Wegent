import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { CollaborationIssue, CollaborationProjectView } from '@wegent/collaboration'
import type {
  ProjectBoardGroupBy,
  StandardCloudBoardMutationUpdate,
} from '@wegent/collaboration/project-board'
import type { DesktopSidebarAccountSettingsOptions } from '@/components/layout/DesktopSidebarAccount'
import type { ArchiveRuntimeConversationsResult } from '@/features/workbench/workbenchContextTypes'
import type { IssueTaskDispatchInput } from '@/features/notifications/NotificationTaskSourceContext'
import type { DeliveryApi, WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import type {
  ProjectWithTasks,
  RuntimeProjectSpaceRef,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  RuntimeWorkListResponse,
  User as UserProfile,
} from '@/types/api'
import type { LocatedProjectSpace } from './projectSpaceSelection'
export type ProjectView = Extract<CollaborationProjectView, 'board' | 'table' | 'files' | 'manage'>
export type WeworkStandardBoardUpdate = Omit<StandardCloudBoardMutationUpdate, 'priority'> & {
  priority?: CollaborationIssue['priority']
  automation_rule_id?: string
}
export type NativeBoardGroupBy = ProjectBoardGroupBy
export type LocatedCloudProject = LocatedProjectSpace
export type LocatedLoopItem = CloudLoopItem & {
  project_store?: RuntimeProjectSpaceRef['projectStore']
}
export type LoopItemTaskBinding = Awaited<ReturnType<DeliveryApi['listTaskBindings']>>[number]
export type BoardReadResult = {
  items: CloudLoopItem[]
  task_bindings?: LoopItemTaskBinding[]
  members?: CloudProjectMember[]
  agents?: ProjectChatAgent[]
  page_cursors?: Record<string, string | null>
}
export type SelectedTaskBinding = Pick<
  LoopItemTaskBinding,
  | 'id'
  | 'task_user_id'
  | 'device_id'
  | 'task_id'
  | 'task_title'
  | 'modelSelection'
  | 'executionContext'
> & {
  work_item_id: string
}
export type TaskBindingAddressInput = Pick<
  LoopItemTaskBinding,
  'device_id' | 'task_id' | 'modelSelection' | 'executionContext'
>
export type TaskComposerRequest = {
  workItemId: string
  initialInput: string
  backgroundAfterSend: boolean
  taskRequest?: RuntimeTaskCreateRequest
  inheritFromTask?: RuntimeTaskAddress | null
  dispatch?: IssueTaskDispatchInput
}
export type AssigneeQuickAddRequest = {
  id: number
  projectKey: string
  target: 'members' | 'agents'
}
export interface CloudTodoWorkspaceProps {
  user: UserProfile
  localProjects: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
  services: WorkbenchServices
  embedded?: boolean
  embeddedTitle?: 'workspace' | 'project'
  startupActive?: boolean
  workspaceActive?: boolean
  activeProjectRef?: RuntimeProjectSpaceRef | null
  defaultProjectRequested?: boolean
  focusedItemId?: string | null
  onFocusedItemHandled?: () => void
  onActiveProjectChange?: (project: LocatedCloudProject | null) => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onMarkRuntimeTaskRead?: (address: RuntimeTaskAddress) => void
  onArchiveRuntimeTasks?: (
    addresses: RuntimeTaskAddress[]
  ) => Promise<ArchiveRuntimeConversationsResult | void> | ArchiveRuntimeConversationsResult | void
  onOpenSettings?: (options?: DesktopSidebarAccountSettingsOptions) => void
  onLogout?: () => void
}
