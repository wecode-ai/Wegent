import { useMemo, type ReactNode } from 'react'
import {
  TodoEditor as SharedIssueDetailEditor,
  createSharedIssueDetailPort,
  type SharedEditorIssue,
  type SharedEditorProject,
  type SharedIssueWorkflow,
  type SharedIssueDetailCreateInput,
  type SharedIssueDetailExtensions,
  type SharedIssueDetailTaskBinding,
  type SharedIssueDetailWorkspaceApi,
} from '@wegent/collaboration'
import type { ProjectChatClient } from '@/api/backend/projectChatSocket'
import type { createProjectChatAgentApi } from '@/api/projectChatAgents'
import type { AITableApi } from '@/api/aitable'
import type {
  CloudLoopItem,
  CloudProject,
  IssueWorkflowInstance,
  LoopItemTaskBinding,
} from '@/api/deliveries'
import type { ProjectWithTasks } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import { reconcileIssueWorkflowForTaskBindings } from '@/api/issueWorkflow'
import { AssignmentChainPopover } from './AssignmentChainPopover'
import { isLoopItemExecutionActive } from './cloudMyWorkModel'
import { StatusHistoryPopover } from './StatusHistoryPopover'
import { TaskDescriptionEditor } from './TaskDescriptionEditor'
import { normalizeTaskDescription } from './taskDescription'
import { AITableTaskFields } from './AITableTaskFields'
import { TaskActivityView } from './TaskActivityView'
import { createWeworkDeliverySharedWorkspaceApi } from '@/features/collaboration/weworkSharedWorkspaceApi'
import { canEditProjectSpaceIssue } from './projectSpaceSelection'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

export interface TodoEditorCreateProps {
  mode: 'create'
  project: CloudProject
  initialParent: CloudLoopItem | null
  initialStatus: CloudLoopItem['status']
  initialTitle?: string
  createOptions?: ReactNode
  onCreated: (item: CloudLoopItem) => void | Promise<void>
  onCreateError?: (
    error: unknown,
    retry: (overrides?: Partial<SharedIssueDetailCreateInput>) => Promise<CloudLoopItem>
  ) => boolean | Promise<boolean>
}

export interface TodoEditorEditProps {
  mode: 'edit'
  item: CloudLoopItem
  project?: CloudProject
  onUpdated: (item: CloudLoopItem) => void
  onAddChild?: () => void
}

type TodoEditorApiProps =
  | {
      sharedApi: Parameters<typeof createSharedIssueDetailPort>[0]
      api?: DeliveryApi
    }
  | {
      sharedApi?: undefined
      api: DeliveryApi
    }

export type TodoEditorProps = TodoEditorApiProps & {
  aitableApi?: AITableApi
  projectChatAgentApi?: ReturnType<typeof createProjectChatAgentApi>
  projectAutomationApi?: Pick<
    NonNullable<WorkbenchServices['projectAutomationApi']>,
    'runWorkflowNode'
  >
  teamApi?: WorkbenchServices['teamApi']
  projectChatClient?: ProjectChatClient
  selfManagedExecution?: boolean
  currentUserId?: string | number
  localProjects?: ProjectWithTasks[]
  allItems: CloudLoopItem[]
  onClose: () => void
  presentation?: 'modal' | 'workspace-panel'
  workspacePanelFill?: boolean
  showPanelControls?: boolean
  showChildren?: boolean
  showCurrentTaskOnly?: boolean
  taskRefreshKey?: string | number
  headerActions?: ReactNode
  selectedTaskId?: string | null
  onCreateTask?: (workflowNodeId?: string) => void
  onOpenTaskConversation?: (task: LoopItemTaskBinding) => void
  onOpenChildTask?: (task: CloudLoopItem) => void
  onWorkflowPlanChanged?: () => void | Promise<void>
} & (TodoEditorCreateProps | TodoEditorEditProps)

export function TodoEditor(props: TodoEditorProps) {
  const { t } = useTranslation('common')
  const workspaceApi = useMemo<SharedIssueDetailWorkspaceApi>(() => {
    if (props.sharedApi) return props.sharedApi
    const deliveryApi = createWeworkDeliverySharedWorkspaceApi(props.api)
    const actorUserId = props.currentUserId === undefined ? undefined : Number(props.currentUserId)
    return {
      ...deliveryApi,
      workflowPlans: {
        ...deliveryApi.workflowPlans,
        decideNode: (issueId, workflowNodeId, action, reason) =>
          props.api.decideWorkflowNode(issueId, workflowNodeId, action, reason, actorUserId),
      },
      automations: props.projectAutomationApi
        ? {
            async runWorkflowNode(projectId, issueId, workflowNodeId, automationId) {
              const run = await props.projectAutomationApi!.runWorkflowNode(
                projectId,
                issueId,
                workflowNodeId,
                automationId
              )
              return { ...run }
            },
          }
        : undefined,
      agents: {
        async list(projectId: string) {
          const agents = (await props.projectChatAgentApi?.list(projectId)) ?? []
          return agents.map(agent => ({ ...agent }))
        },
      },
    }
  }, [
    props.api,
    props.currentUserId,
    props.projectAutomationApi,
    props.projectChatAgentApi,
    props.sharedApi,
  ])
  const port = useMemo(
    () =>
      createSharedIssueDetailPort(workspaceApi, async (blob, filename) => {
        await saveBlobToDownloads(blob, filename)
      }),
    [workspaceApi]
  )

  const extensions: SharedIssueDetailExtensions = {
    normalizeDescription: normalizeTaskDescription,
    isExecutionActive: item => isLoopItemExecutionActive(item as CloudLoopItem),
    reconcileWorkflow: (workflow, tasks) =>
      reconcileIssueWorkflowForTaskBindings(
        workflow as unknown as IssueWorkflowInstance,
        tasks as LoopItemTaskBinding[]
      ) as unknown as SharedIssueWorkflow,
    renderDescriptionEditor: context => (
      <TaskDescriptionEditor
        value={context.value}
        onChange={context.onChange}
        onPasteFiles={context.onPasteFiles}
        readAttachment={context.readAttachment}
        disabled={!context.editable}
      />
    ),
    renderActivity: context =>
      props.projectChatClient ? (
        <TaskActivityView
          key={`${context.item.id}:${context.item.assignee_team_id ?? context.item.assignee_agent_id ?? 'unassigned'}`}
          client={props.projectChatClient}
          project={context.project as CloudProject}
          task={context.item as CloudLoopItem}
          currentUserId={props.currentUserId}
          onTaskUpdated={item => context.onItemChange(item as SharedEditorIssue)}
          projectChatAgentApi={props.projectChatAgentApi}
          localProjects={props.localProjects}
          selfManagedExecution={props.selfManagedExecution}
          workflowManagerRunId={context.workflowManagerRunId}
          onWorkflowManagerExecutionChange={context.onOpenManagerExecutionChange}
          onWorkflowManagerFinished={context.onWorkflowManagerFinished}
          taskBindings={context.tasks as LoopItemTaskBinding[]}
          onOpenTask={props.onOpenTaskConversation}
          onRefreshTaskBindings={context.onTaskBindingsChange}
          linear
        />
      ) : null,
    renderAITableFields: context =>
      props.aitableApi ? (
        <AITableTaskFields
          api={props.aitableApi}
          project={context.project as CloudProject}
          item={context.item as CloudLoopItem}
        />
      ) : null,
    renderAssignmentHistory: context => (
      <AssignmentChainPopover
        anchor={context.anchor}
        entries={context.entries as NonNullable<CloudLoopItem['assignment_history']>}
        projectMembers={context.members}
        onClose={context.onClose}
      />
    ),
    renderStatusHistory: context => (
      <StatusHistoryPopover
        anchor={context.anchor}
        entries={context.entries as NonNullable<CloudLoopItem['status_history']>}
        projectMembers={context.members}
        onClose={context.onClose}
      />
    ),
    renderCreateOptions:
      props.mode === 'create' && props.createOptions ? () => props.createOptions : undefined,
  }

  const commonProps = {
    port,
    extensions,
    translate: (key: string, fallback?: string, options?: Record<string, string | number>) =>
      fallback === undefined ? t(key, options) : t(key, fallback, options),
    loadTeams: () => props.teamApi?.listTeams() ?? Promise.resolve([]),
    allItems: props.allItems as SharedEditorIssue[],
    onClose: props.onClose,
    presentation: props.presentation,
    workspacePanelFill: props.workspacePanelFill,
    showPanelControls: props.showPanelControls,
    showChildren: props.showChildren,
    showCurrentTaskOnly: props.showCurrentTaskOnly,
    taskRefreshKey: props.taskRefreshKey,
    headerActions: props.headerActions,
    selectedTaskId: props.selectedTaskId,
    onCreateTask: props.onCreateTask,
    onOpenTaskConversation: props.onOpenTaskConversation
      ? (task: SharedIssueDetailTaskBinding) =>
          props.onOpenTaskConversation?.(task as unknown as LoopItemTaskBinding)
      : undefined,
    onWorkflowPlanChanged: props.onWorkflowPlanChanged,
  }

  return props.mode === 'create' ? (
    <SharedIssueDetailEditor
      {...commonProps}
      mode="create"
      project={props.project as SharedEditorProject}
      initialParent={props.initialParent as SharedEditorIssue | null}
      initialStatus={props.initialStatus}
      initialTitle={props.initialTitle}
      onCreated={item => props.onCreated(item as CloudLoopItem)}
      onCreateError={
        props.onCreateError
          ? (error, retry) =>
              props.onCreateError?.(error, overrides =>
                retry(overrides).then(item => item as CloudLoopItem)
              ) ?? false
          : undefined
      }
    />
  ) : (
    <SharedIssueDetailEditor
      {...commonProps}
      mode="edit"
      item={props.item as SharedEditorIssue}
      editable={canEditProjectSpaceIssue({
        ...props.item,
        project_store:
          (props.item as CloudLoopItem & { project_store?: 'local' | 'backend' }).project_store ??
          props.project?.project_store,
      })}
      project={props.project as SharedEditorProject | undefined}
      onUpdated={item => props.onUpdated(item as CloudLoopItem)}
      onAddChild={props.onAddChild}
      onOpenChildTask={
        props.onOpenChildTask ? item => props.onOpenChildTask?.(item as CloudLoopItem) : undefined
      }
    />
  )
}
