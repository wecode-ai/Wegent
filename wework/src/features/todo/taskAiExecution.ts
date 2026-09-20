import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { Attachment, ProjectWithTasks, ModelOptions, UnifiedModel } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { publishProjectSpaceTaskBindingChanged } from './projectSpaceSelection'
import { startTaskAiRun as startSharedTaskAiRun } from '@wegent/collaboration/execution/taskAiExecution'
export {
  buildRobotRoleDescription,
  selectActivityRerunModel,
  formatThreadHistory,
  mergeProjectChatMessages,
} from '@wegent/collaboration/execution/taskAiExecution'
export type TaskAiRuntimeBridge = Pick<
  WorkbenchContextValue,
  'createProjectRuntimeTask' | 'sendRuntimePaneMessage'
>

export interface StartTaskAiRunInput {
  client: ProjectChatClient
  services: Pick<WorkbenchServices, 'deliveryApi'> & {
    chatStream?: WorkbenchServices['chatStream']
  }
  runtime: TaskAiRuntimeBridge
  project: CloudProject
  task: CloudLoopItem
  agent: ProjectChatAgent
  /** Explicit code workspace selected for this comment. */
  executionProject?: ProjectWithTasks | null
  prompt: string
  trigger?: ProjectChatMessage
  autoRetry?: boolean
  messages: ProjectChatMessage[]
  /** Model list retained for the caller contract; Runtime selection owns defaults. */
  models?: UnifiedModel[]
  /** Per-comment model selection. */
  selectedModel?: UnifiedModel | null
  selectedModelOptions?: ModelOptions
  /** When replying to an existing AI message, continue the executor session of
   * that message's parent comment instead of starting a new session. */
  replyTo?: { runtimeDeviceId: string; runtimeTaskId: string } | null
  /** The parent comment owning this run. Scopes rebuilt-session history to a
   * single thread when a lost session has to be recreated for a reply. */
  threadRootId?: string | null
  /** Target the run at the robot's execution environment device. */
  deviceId?: string | null
  /** Files attached to the comment; uploaded before the run starts. */
  attachments?: Attachment[]
  onError: (error: string) => void
  onMessages: (messages: ProjectChatMessage[]) => void
  onTaskUpdated?: (task: CloudLoopItem) => void
  startFailedText: string
}

export function startTaskAiRun(input: StartTaskAiRunInput): Promise<boolean> {
  return startSharedTaskAiRun<ProjectWithTasks, CloudLoopItem>({
    ...input,
    onBindingChange: publishProjectSpaceTaskBindingChanged,
  })
}
