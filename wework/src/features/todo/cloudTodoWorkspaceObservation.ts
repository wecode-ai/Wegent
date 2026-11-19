import type { BackgroundTaskRequest } from './backgroundTaskCommand'
import type { useAssignmentNotificationChoice } from '@/features/notifications/useAssignmentNotificationChoice'
import type { useTranslation } from '@/hooks/useTranslation'
import type { createCollaborationTranslator, CollaborationStatus } from '@wegent/collaboration'
import type { ProjectBoardGroupBy } from '@wegent/collaboration/project-board'
import type { RuntimeTaskSummary } from '@/types/api'
import type { useCollaborationWorkspaceController, SharedWorkspaceApi } from '@wegent/collaboration'
import type { useStandardCloudBoardController } from '@wegent/collaboration/project-board'
import type { DeliveryApi, WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type { CloudTodoBoardTaskBinding } from './CloudTodoBoardCard'
import type { ChangeRequestMonitor } from '@/features/workbench/changeRequestMonitor'
import type { RuntimeTaskAddress } from '@/types/api'
import type {
  CloudTodoWorkspaceProps,
  LocatedCloudProject,
  LocatedLoopItem,
  LoopItemTaskBinding,
} from './cloudTodoWorkspaceTypes'
export interface CloudTodoWorkspaceObservation {
  backgroundTask?: {
    key: number
    props: BackgroundTaskRequest
    workbench: Pick<WorkbenchContextValue, 'state' | 'createProjectRuntimeTask'>
  }
  notificationChoice: ReturnType<typeof useAssignmentNotificationChoice>
  t: ReturnType<typeof useTranslation>['t']
  boardTranslate: ReturnType<typeof createCollaborationTranslator>
  runtimeTasksByKey: Map<string, RuntimeTaskSummary>
  nativeGroupBy: ProjectBoardGroupBy
  nativeStatuses: CollaborationStatus[]
  processingStartIndex: number
  props: CloudTodoWorkspaceProps
  cloud: ReturnType<typeof useCollaborationWorkspaceController>
  cloudApi: SharedWorkspaceApi | null | undefined
  localApi: DeliveryApi | undefined
  catalogApi: DeliveryApi | undefined
  project: LocatedCloudProject | null
  projects: LocatedCloudProject[]
  requestedProjectRef: CloudTodoWorkspaceProps['activeProjectRef']
  defaultProject: LocatedCloudProject | null
  activeProjectKey: string | null | undefined
  projectApi: DeliveryApi | undefined
  projectAgents: WorkbenchServices['projectChatAgentApi']
  projectChat: WorkbenchServices['projectChatClient']
  itemProject: LocatedCloudProject | undefined
  itemApi: DeliveryApi | undefined
  board: ReturnType<typeof useStandardCloudBoardController>
  sourceItems: LocatedLoopItem[]
  runtimeSignature: string
  runtimeAddressesByWorkItem: Map<string, RuntimeTaskAddress[]>
  taskBindings: Record<string, LoopItemTaskBinding[]>
  boardBindings: Record<string, CloudTodoBoardTaskBinding[]>
  localBindingsProjectKey: string | null
  monitor: ChangeRequestMonitor | null
  workbench: WorkbenchContextValue | null
  startupReady: boolean
  taskPanelOpen: boolean
  detailLoadError: string
  repairFailedError: string
}
