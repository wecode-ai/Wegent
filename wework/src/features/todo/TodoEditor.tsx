import type { AITableApi } from '@/api/aitable'
import type { ProjectChatClient } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject, LoopItemTaskBinding } from '@/api/deliveries'
import type { createProjectChatAgentApi } from '@/api/projectChatAgents'
import { AttachmentPreviewContext } from '@/components/chat/AttachmentPreviewContext'
import { createWeworkDeliverySharedWorkspaceApi } from '@/features/collaboration/weworkSharedWorkspaceApi'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import type { ProjectWithTasks, RuntimeTaskAddress } from '@/types/api'
import type { WorkspaceAttachmentPreviewSource } from '@/types/workspace-files'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import type {
  CollaborationAssignment,
  CollaborationAttachment,
  SharedEditorIssue,
  SharedEditorProject,
  SharedIssueDetailCreateInput,
  SharedIssueDetailExtensions,
  SharedIssueDetailTaskBinding,
  SharedIssueDetailTaskExecutionState,
  SharedIssueDetailWorkspaceApi,
} from '@wegent/collaboration'
import {
  createCollaborationTranslator,
  createSharedIssueDetailPort,
  formatIssueAttachmentSize,
  IssueMarkdownProvider,
  TodoEditor as SharedIssueDetailEditor,
} from '@wegent/collaboration'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Send } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { AITableTaskFields } from './AITableTaskFields'
import { AssignmentChainPopover } from './AssignmentChainPopover'
import { CloudFilePreviewDialog } from './CloudFilePreviewDialog'
import { isLoopItemExecutionActive } from './cloudMyWorkModel'
import {
  createIssueAssignmentReceiptObservation,
  getEmptyAssignmentReceiptSnapshot,
} from './issueAssignmentReceiptObservation'
import { IssueAssignmentReceipts } from './IssueAssignmentReceipts'
import { issueAssignmentRevision } from './issueAssignmentReceiptScope'
import type { ExistingIssueTaskSource } from './IssueExistingTaskAction'
import { IssueExistingTaskAction } from './IssueExistingTaskAction'
import { IssueWebLinkButton } from './IssueWebLinkButton'
import { canEditProjectSpaceIssue } from './projectSpaceSelection'
import { StatusHistoryPopover } from './StatusHistoryPopover'
import type { StartHumanTaskFromReplyInput } from './TaskActivityView'
import { TaskActivityView } from './TaskActivityView'
import { normalizeTaskDescription } from './taskDescription'
import { TaskDescriptionEditor } from './TaskDescriptionEditor'

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
  onRead?: (item: CloudLoopItem) => void
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
  commentBoard?: import('@wegent/collaboration').IssueCommentBoardContext
  aitableApi?: AITableApi
  projectChatAgentApi?: ReturnType<typeof createProjectChatAgentApi>
  teamApi?: WorkbenchServices['teamApi']
  projectChatClient?: ProjectChatClient
  selfManagedExecution?: boolean
  currentUserId?: string | number
  currentAssignment?: CollaborationAssignment | null
  localProjects?: ProjectWithTasks[]
  allItems: CloudLoopItem[]
  /** Opens the activity list on one comment instead of the newest message. */
  focusedCommentId?: string | null
  focusedCommentRequestKey?: string | null
  onClose: () => void
  onEscape?: () => void
  presentation?: 'modal' | 'workspace-panel'
  workspacePanelFill?: boolean
  readFirst?: boolean
  showPanelControls?: boolean
  showFullscreenControl?: boolean
  showChildren?: boolean
  showCurrentTaskOnly?: boolean
  defaultAssistant?: import('@wegent/collaboration').CollaborationDefaultAssistant
  taskRefreshKey?: string | number
  getRuntimeTranscript?: NonNullable<WorkbenchServices['runtimeWorkApi']>['getRuntimeTranscript']
  initialTaskBindings?: LoopItemTaskBinding[]
  taskExecutionStates?: Readonly<Record<string, SharedIssueDetailTaskExecutionState>>
  deviceNamesById?: Readonly<Record<string, string>>
  headerActions?: ReactNode
  onAddAssigneeMember?: () => void
  onAddAssigneeAgent?: () => void
  selectedTaskId?: string | null
  /** Delete this Issue; rendered in the header overflow menu in edit mode. */
  onDelete?: () => void
  deleteLabel?: string
  existingTaskSource?: ExistingIssueTaskSource
  onCreateTask?: () => void
  onOpenTaskConversation?: (task: LoopItemTaskBinding) => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => void
  onOpenChildTask?: (task: CloudLoopItem) => void
  onOpenRelatedIssue?: (issue: CloudLoopItem) => void
  /** Starts the work item a manager assigned this member, from a reply. */
  onStartHumanTaskFromReply?: (input: StartHumanTaskFromReplyInput) => void | Promise<void>
} & (TodoEditorCreateProps | TodoEditorEditProps)

function canCreatePersonalTask(props: TodoEditorProps): boolean {
  if (props.mode !== 'edit' || !props.onCreateTask || props.currentUserId === undefined) {
    return false
  }

  if (props.item.assignee_user_id != null) {
    return String(props.item.assignee_user_id) === String(props.currentUserId)
  }
  if (props.item.assignee_agent_id || props.item.assignee_group_id || props.item.assignee_team_id) {
    return false
  }

  if (props.currentAssignment?.status === 'active') {
    return (
      props.currentAssignment.target_type === 'human' &&
      String(props.currentAssignment.target_id) === String(props.currentUserId)
    )
  }

  return true
}

export function TodoEditor(props: TodoEditorProps) {
  const { t, i18n } = useTranslation('common')
  const [taskLinkRevision, setTaskLinkRevision] = useState(0)
  const taskOwnerUserId = props.project?.project_store === 'local' ? 0 : props.currentUserId
  const collaboratorEditingSupported = props.project?.project_store !== 'local'
  const showPersonalTaskAction = canCreatePersonalTask(props)
  const [previewAttachment, setPreviewAttachment] = useState<{
    filename: string
    contentType: string | null
    sizeBytes: number
    loadFile: () => Promise<Blob>
    download: () => Promise<void>
  } | null>(null)
  const collaborationTranslate = useMemo(
    () => createCollaborationTranslator(i18n.language.startsWith('zh') ? 'zh-CN' : 'en'),
    [i18n.language]
  )
  const workspaceApi = useMemo<SharedIssueDetailWorkspaceApi>(() => {
    if (props.sharedApi) return props.sharedApi
    const deliveryApi = createWeworkDeliverySharedWorkspaceApi(props.api)
    return {
      ...deliveryApi,
      agents: {
        async list(projectId: string) {
          const agents = (await props.projectChatAgentApi?.list(projectId)) ?? []
          return agents.map(agent => ({ ...agent }))
        },
      },
    }
  }, [props.api, props.projectChatAgentApi, props.sharedApi])
  const receiptApi = useMemo(
    () =>
      workspaceApi.assignmentReceipts
        ? {
            getIssueAssignmentReceipts: workspaceApi.assignmentReceipts.list,
            acknowledgeIssueAssignment: workspaceApi.assignmentReceipts.acknowledge,
            getLoopItem: workspaceApi.issues.get,
          }
        : undefined,
    [workspaceApi]
  )
  const receiptObservation = useMemo(
    () => (receiptApi ? createIssueAssignmentReceiptObservation(receiptApi) : null),
    [receiptApi]
  )
  const assignmentReceipts = useSyncExternalStore(
    receiptObservation?.subscribe ?? subscribeIdleResource,
    receiptObservation?.getSnapshot ?? getEmptyAssignmentReceiptSnapshot,
    getEmptyAssignmentReceiptSnapshot
  )
  const attachmentProjectId = props.project ? String(props.project.id) : undefined
  const attachmentIssueId = props.mode === 'edit' ? props.item.id : undefined
  const attachmentContext = useMemo(
    () =>
      attachmentProjectId && attachmentIssueId
        ? { projectId: attachmentProjectId, issueId: attachmentIssueId }
        : undefined,
    [attachmentProjectId, attachmentIssueId]
  )
  const port = useMemo(() => {
    const detailPort = createSharedIssueDetailPort(
      workspaceApi,
      async (blob, filename) => {
        await saveBlobToDownloads(blob, filename)
      },
      props.getRuntimeTranscript,
      attachmentContext
    )
    return {
      ...detailPort,
      collaborators: {
        ...detailPort.collaborators,
        editingSupported: collaboratorEditingSupported,
      },
      taskBindings: {
        async list(...args: Parameters<typeof detailPort.taskBindings.list>) {
          const tasks = await detailPort.taskBindings.list(...args)
          return tasks.filter(
            task =>
              taskOwnerUserId !== undefined && String(task.task_user_id) === String(taskOwnerUserId)
          )
        },
      },
    }
  }, [
    workspaceApi,
    taskOwnerUserId,
    props.getRuntimeTranscript,
    attachmentContext,
    collaboratorEditingSupported,
  ])
  const openIssueAttachment = useCallback(
    (id: string, filename: string, contentType: string | null, sizeBytes: number) => {
      setPreviewAttachment({
        filename,
        contentType,
        sizeBytes,
        loadFile: () =>
          attachmentContext
            ? workspaceApi.attachments.read(id, attachmentContext)
            : workspaceApi.attachments.read(id),
        download: () => port.attachments.download(id, filename),
      })
    },
    [workspaceApi.attachments, attachmentContext, port.attachments]
  )
  const openResourceAttachment = useCallback(
    (attachment: CollaborationAttachment) => {
      openIssueAttachment(
        attachment.id,
        attachment.display_name,
        attachment.content_type,
        attachment.size_bytes
      )
    },
    [openIssueAttachment]
  )
  const openStagedAttachment = useCallback((source: WorkspaceAttachmentPreviewSource) => {
    setPreviewAttachment({
      ...source,
      sizeBytes: 0,
      download: async () => {
        await saveBlobToDownloads(await source.loadFile(), source.filename)
      },
    })
  }, [])
  const loadTeams = useCallback(
    () => props.teamApi?.listTeams() ?? Promise.resolve([]),
    [props.teamApi]
  )

  const extensions: SharedIssueDetailExtensions = {
    normalizeDescription: normalizeTaskDescription,
    isExecutionActive: item => isLoopItemExecutionActive(item as CloudLoopItem),
    openAttachment: async (id, filename, contentType, sizeBytes) => {
      openIssueAttachment(id, filename, contentType, sizeBytes)
    },
    renderDescriptionEditor: context => (
      <TaskDescriptionEditor
        value={context.value}
        ariaLabel={t('todo.issue_description_label')}
        placeholder={context.placeholder}
        onChange={context.onChange}
        onPasteFiles={context.onPasteFiles}
        readAttachment={context.readAttachment}
        onInlineAttachmentIdsChange={context.onInlineAttachmentIdsChange}
        disabled={!context.editable}
      />
    ),
    renderActivity: context =>
      props.projectChatClient && context.project ? (
        <TaskActivityView
          assignmentReceipts={assignmentReceipts}
          commentAssignment={context.commentAssignment}
          commentActions={context.commentActions}
          key={context.item.id}
          client={props.projectChatClient}
          project={context.project as CloudProject}
          task={context.item as CloudLoopItem}
          currentUserId={props.currentUserId}
          onTaskRead={props.mode === 'edit' ? props.onRead : undefined}
          onTaskUpdated={item => context.onItemChange(item as SharedEditorIssue)}
          projectChatAgentApi={props.projectChatAgentApi}
          localProjects={props.localProjects}
          selfManagedExecution={props.selfManagedExecution}
          deviceNamesById={props.deviceNamesById}
          taskBindings={context.tasks as LoopItemTaskBinding[]}
          statusHistory={
            props.presentation === 'workspace-panel' ? context.item.status_history : undefined
          }
          projectMembers={context.members as import('@/api/deliveries').CloudProjectMember[]}
          issueTimeline={props.presentation === 'workspace-panel'}
          onOpenTask={props.onOpenTaskConversation}
          onOpenRuntimeTask={props.onOpenRuntimeTask}
          onStartHumanTaskFromReply={props.onStartHumanTaskFromReply}
          onRefreshExecutionArtifacts={context.onExecutionArtifactsChange}
          members={context.members}
          agents={context.agents}
          focusedCommentId={props.focusedCommentId}
          focusedCommentRequestKey={props.focusedCommentRequestKey}
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
    renderAssignmentReceipts: item =>
      receiptApi ? (
        <IssueAssignmentReceipts
          key={item.id}
          api={receiptApi}
          issueId={item.id}
          version={item.version}
          assignmentRevision={issueAssignmentRevision(item)}
          currentUserId={props.currentUserId}
          assigneeUserId={item.assignee_user_id}
          observation={receiptObservation ?? undefined}
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
    renderPersonalTaskAction:
      showPersonalTaskAction && props.onCreateTask
        ? ({ onCreateTask }) => {
            return (
              <span
                className="task-detail-personal-task"
                data-testid="cloud-todo-personal-task-action"
              >
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="cloud-todo-personal-task-start"
                  title={`${t('todo.personal_task_title')} · ${t('todo.personal_task_description')}`}
                  onClick={onCreateTask}
                >
                  <Send aria-hidden="true" size={14} />
                  {t('todo.create_personal_task')}
                </ControlButton>
              </span>
            )
          }
        : undefined,
  }

  const commonProps = {
    port,
    extensions,
    translate: (key: string, fallback?: string, options?: Record<string, string | number>) => {
      const shared = collaborationTranslate(key, undefined, options)
      if (shared !== key) return shared
      return fallback === undefined ? t(key, options) : t(key, fallback, options)
    },
    loadTeams,
    allItems: props.allItems as SharedEditorIssue[],
    onClose: props.onClose,
    onEscape: props.onEscape,
    presentation: props.presentation,
    commentBoard: props.commentBoard,
    workspacePanelFill: props.workspacePanelFill,
    readFirst: props.readFirst,
    showPanelControls: props.showPanelControls,
    showFullscreenControl: props.showFullscreenControl,
    showChildren: props.showChildren,
    showCurrentTaskOnly: props.showCurrentTaskOnly,
    defaultAssistant: props.defaultAssistant,
    taskRefreshKey: `${props.taskRefreshKey ?? ''}:${taskLinkRevision}`,
    initialTaskBindings: props.initialTaskBindings?.filter(
      task => taskOwnerUserId !== undefined && String(task.task_user_id) === String(taskOwnerUserId)
    ) as SharedIssueDetailTaskBinding[] | undefined,
    taskExecutionStates: props.taskExecutionStates,
    deviceNamesById: props.deviceNamesById,
    headerActions: (
      <>
        {props.mode === 'edit' ? (
          <IssueWebLinkButton key={props.item.id} project={props.project} issueId={props.item.id} />
        ) : null}
        {props.headerActions}
      </>
    ),
    canStartWork: false,
    selectedTaskId: props.selectedTaskId,
    currentAssignment: props.currentAssignment,
    linkedTaskAction:
      props.mode === 'edit' && canEditProjectSpaceIssue(props.item) && props.existingTaskSource ? (
        <IssueExistingTaskAction
          deviceNamesById={props.deviceNamesById}
          key={props.item.id}
          source={props.existingTaskSource}
          issue={props.item}
          project={{
            projectStore: props.project?.project_store ?? 'backend',
            projectId: props.project?.id ?? props.item.cloud_project_id,
          }}
          bindings={props.initialTaskBindings}
          onLinked={() => setTaskLinkRevision(value => value + 1)}
        />
      ) : undefined,
    onCreateTask: props.onCreateTask,
    onAddAssigneeMember: props.onAddAssigneeMember,
    onAddAssigneeAgent: props.onAddAssigneeAgent,
    onOpenTaskConversation: props.onOpenTaskConversation
      ? (task: SharedIssueDetailTaskBinding) =>
          props.onOpenTaskConversation?.(task as unknown as LoopItemTaskBinding)
      : undefined,
  }

  const editor =
    props.mode === 'create' ? (
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
        onDelete={props.onDelete}
        deleteLabel={props.deleteLabel}
        onAddChild={props.onAddChild}
        onOpenChildTask={
          props.onOpenChildTask ? item => props.onOpenChildTask?.(item as CloudLoopItem) : undefined
        }
        onOpenRelatedIssue={
          props.onOpenRelatedIssue
            ? item => props.onOpenRelatedIssue?.(item as CloudLoopItem)
            : undefined
        }
      />
    )

  return (
    <AttachmentPreviewContext.Provider value={openStagedAttachment}>
      <IssueMarkdownProvider
        attachments={workspaceApi.attachments}
        issueId={attachmentIssueId}
        projectId={attachmentProjectId}
        onOpenAttachment={openResourceAttachment}
      >
        {editor}
        {previewAttachment ? (
          <CloudFilePreviewDialog
            filename={previewAttachment.filename}
            contentType={previewAttachment.contentType}
            sizeLabel={
              previewAttachment.sizeBytes > 0
                ? formatIssueAttachmentSize(previewAttachment.sizeBytes)
                : null
            }
            loadFile={previewAttachment.loadFile}
            onDownload={previewAttachment.download}
            onClose={() => setPreviewAttachment(null)}
          />
        ) : null}
      </IssueMarkdownProvider>
    </AttachmentPreviewContext.Provider>
  )
}
