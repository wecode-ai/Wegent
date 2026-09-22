import { IssueTaskConversationPanel } from '@wegent/collaboration'
import { ArrowUpRight, Bot, ChevronDown, MessageSquare, Plus, Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { WorkbenchHarnessSelector } from '@/components/layout/WorkbenchHarnessSelector'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { resolveRuntimeTaskProjects } from '@/lib/runtime-project'
import {
  runtimeTaskProjectUiId,
  withoutRuntimeTaskWorkspaceBinding,
} from '@/lib/runtime-task-workspace-binding'
import { cn } from '@/lib/utils'
import { findWorkbenchDevice, getWorkbenchDeviceDisplayName } from '@/lib/workbench-device'
import type {
  ProjectExecutionMode,
  ProjectWithTasks,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
} from '@/types/api'
import { ConnectedIssueProjectWork } from './ConnectedIssueProjectWork'
import { useProjectRuntimeTaskComposer } from './useProjectRuntimeTaskComposer'
import { WorkItemComposerGuide } from './WorkItemComposerGuide'
import { buildWorkItemRuntimeContext } from './workItemRuntimeContext'

interface AiChatModalProps {
  project: CloudProject
  localProjects: ProjectWithTasks[]
  task?: CloudLoopItem
  /** When false the panel stays mounted (conversation state and stream keep
   * running) but the overlay is hidden, so reopening shows the last messages
   * even while the temporary task is still executing. */
  open: boolean
  onClose: () => void
  onBack?: () => void
  initialAddress?: RuntimeTaskAddress | null
  initialLocalProjectId?: number | null
  initialTaskRequest?: RuntimeTaskCreateRequest | null
  inheritFromTask?: RuntimeTaskAddress | null
  taskTitle?: string | null
  initialTaskInput?: string
  workflowNodeId?: string
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onAddressChange?: (address: RuntimeTaskAddress) => void
  onTaskCreated?: (
    address: RuntimeTaskAddress,
    localProject: ProjectWithTasks | null
  ) => Promise<void> | void
  prepareTask?: (
    address: RuntimeTaskAddress,
    localProject: ProjectWithTasks | null
  ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
  embedded?: boolean
}

interface AutomaticIssueTaskComposerProps {
  project: ProjectWithTasks | null
  deviceWorkspaceId: number | null
  projectWork?: Parameters<typeof TemporaryChatPanel>[0]['projectWork']
  inheritFromTask: RuntimeTaskAddress | null
  taskRequest: RuntimeTaskCreateRequest | null
  runtimeContext: Pick<RuntimeSendRequest, 'cloudProjectId' | 'origin' | 'additionalContext'>
  prepareTask?: AiChatModalProps['prepareTask']
  onTaskCreated?: AiChatModalProps['onTaskCreated']
  panelProps: Omit<
    Parameters<typeof TemporaryChatPanel>[0],
    'createTask' | 'projectWork' | 'currentProject'
  >
}

const isolatedWorkspaceExecution: RuntimeTaskCreateRequest['execution'] = {
  workspace: { source: 'git_worktree' },
}

function automaticExecutionMode(
  projectWork: AutomaticIssueTaskComposerProps['projectWork'],
  inheritFromTask: RuntimeTaskAddress | null,
  taskRequest: RuntimeTaskCreateRequest | null
): ProjectExecutionMode {
  if (inheritFromTask) return 'current_workspace'
  if (taskRequest?.execution?.workspace?.source === 'git_worktree') return 'git_worktree'
  return projectWork?.worktreeAvailability?.available ? 'git_worktree' : 'current_workspace'
}

function AutomaticIssueTaskComposer({
  project,
  deviceWorkspaceId,
  projectWork,
  inheritFromTask,
  taskRequest,
  runtimeContext,
  prepareTask,
  onTaskCreated,
  panelProps,
}: AutomaticIssueTaskComposerProps) {
  const executionMode = automaticExecutionMode(projectWork, inheritFromTask, taskRequest)
  const effectiveTaskRequest = taskRequest
    ? {
        ...taskRequest,
        execution:
          executionMode === 'git_worktree'
            ? {
                workspace: {
                  source: 'git_worktree',
                  ...(taskRequest.execution?.workspace?.source === 'git_worktree' &&
                  taskRequest.execution.workspace.branch
                    ? { branch: taskRequest.execution.workspace.branch }
                    : {}),
                },
              }
            : undefined,
      }
    : null
  const createConversation = useProjectRuntimeTaskComposer({
    project,
    deviceWorkspaceId,
    workspaceExecution:
      inheritFromTask || effectiveTaskRequest
        ? undefined
        : executionMode === 'git_worktree'
          ? isolatedWorkspaceExecution
          : null,
    workspaceSource: inheritFromTask,
    taskRequest: effectiveTaskRequest,
    runtimeContext,
    prepareTask,
    onTaskCreated,
  })

  return (
    <TemporaryChatPanel
      {...panelProps}
      currentProject={project}
      createTask={createConversation}
      projectWork={
        projectWork
          ? {
              ...projectWork,
              executionMode,
              executionModeLocked: true,
            }
          : undefined
      }
    />
  )
}

function lastAddressStorageKey(projectId: string | number, taskId?: string): string {
  return `wework-ai-chat:${projectId}:${taskId ?? 'project'}`
}

function storedLastAddress(key: string): RuntimeTaskAddress | null {
  try {
    const value = window.localStorage.getItem(key)
    return value ? (JSON.parse(value) as RuntimeTaskAddress) : null
  } catch {
    return null
  }
}

export function AiChatModal({
  project,
  localProjects,
  task,
  open,
  onClose,
  onBack,
  initialAddress = null,
  initialLocalProjectId = null,
  initialTaskRequest = null,
  inheritFromTask = null,
  taskTitle,
  initialTaskInput = '',
  workflowNodeId,
  onOpenRuntimeTask,
  onAddressChange,
  onTaskCreated,
  prepareTask,
  embedded = false,
}: AiChatModalProps) {
  const { t } = useTranslation('common')
  const { state } = useWorkbenchPaneContext()
  const runtimeTaskProjects = useMemo(
    () => resolveRuntimeTaskProjects(localProjects, state?.runtimeWork),
    [localProjects, state?.runtimeWork]
  )
  const hasPreparedEnvironmentTarget = Boolean(
    initialTaskRequest?.deviceId?.trim() && initialTaskRequest.workspacePath?.trim()
  )
  const storageKey = lastAddressStorageKey(project.id, task?.id)
  const initialAddressKey = initialAddress ? JSON.stringify(initialAddress) : null
  const hasInitialAddress = Boolean(initialAddress)
  const [addressState, setAddressState] = useState<{
    initialAddressKey: string | null
    address: RuntimeTaskAddress | null
  }>(() => ({
    initialAddressKey,
    address: initialAddress ?? storedLastAddress(storageKey),
  }))
  const currentAddress =
    addressState.initialAddressKey === initialAddressKey
      ? addressState.address
      : (initialAddress ?? addressState.address)
  const issueId = task?.id
  const conversationAddress = useMemo(
    () =>
      currentAddress && issueId && project.project_store === 'backend'
        ? {
            ...currentAddress,
            projectSession: { projectId: String(project.id), issueId },
          }
        : currentAddress,
    [currentAddress, project.id, project.project_store, issueId]
  )
  const notifiedInitialAddressRef = useRef(hasInitialAddress)
  // Compose a fresh temporary task (panel remounts without a saved address)
  // or return to the current conversation. The panel only reads the address on
  // mount, so explicit toggles bump the remount key; creating a new runtime
  // task must NOT remount (the panel already switched to it internally).
  const [composeNew, setComposeNew] = useState(false)
  const [sessionKey, setSessionKey] = useState(0)
  const [localProjectId, setLocalProjectId] = useState<number | null>(() => {
    const requestedProjectId = runtimeTaskProjectUiId(state?.runtimeWork, initialTaskRequest)
    const initialProjectId = hasPreparedEnvironmentTarget
      ? null
      : (requestedProjectId ?? initialLocalProjectId)
    const matched = runtimeTaskProjects.find(candidate => candidate.id === initialProjectId)
    return matched?.id ?? null
  })
  const [localDeviceWorkspaceId, setLocalDeviceWorkspaceId] = useState<number | null>(
    initialTaskRequest?.deviceWorkspaceId ?? null
  )
  const selectedLocalProject =
    runtimeTaskProjects.find(candidate => candidate.id === localProjectId) ?? null
  const selectLocalProject = useCallback((projectId: number | null) => {
    setLocalProjectId(projectId)
    setLocalDeviceWorkspaceId(null)
  }, [])
  const selectLocalProjectWorkspace = useCallback(
    (projectId: number, deviceWorkspaceId: number | null) => {
      setLocalProjectId(projectId)
      setLocalDeviceWorkspaceId(deviceWorkspaceId)
    },
    []
  )
  const runtimeContext = useMemo(
    () => buildWorkItemRuntimeContext(project, task, workflowNodeId),
    [project, task, workflowNodeId]
  )
  const executionDeviceName = useMemo(() => {
    const deviceId = initialAddress?.deviceId ?? null
    return getWorkbenchDeviceDisplayName(
      findWorkbenchDevice(state?.devices ?? [], deviceId),
      deviceId
    )
  }, [initialAddress?.deviceId, state?.devices])

  // Embedded panes handle Escape locally so sibling drawers keep their context.
  useEffect(() => {
    if (!open || embedded) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [embedded, onClose, open])

  const taskRequest = useMemo(() => {
    if (!initialTaskRequest) return null
    const directEnvironmentTarget =
      !selectedLocalProject &&
      initialTaskRequest.deviceId?.trim() &&
      initialTaskRequest.workspacePath?.trim()
        ? {
            deviceId: initialTaskRequest.deviceId.trim(),
            workspacePath: initialTaskRequest.workspacePath.trim(),
          }
        : {}
    return {
      ...withoutRuntimeTaskWorkspaceBinding(initialTaskRequest),
      ...directEnvironmentTarget,
      ...runtimeContext,
    }
  }, [initialTaskRequest, runtimeContext, selectedLocalProject])
  const rememberAddress = useCallback(
    (address: RuntimeTaskAddress | null) => {
      if (!address) return
      window.localStorage.setItem(storageKey, JSON.stringify(address))
      setAddressState({ initialAddressKey, address })
      setComposeNew(false)
      if (!notifiedInitialAddressRef.current) {
        notifiedInitialAddressRef.current = true
        if (!hasInitialAddress) onAddressChange?.(address)
      }
    },
    [hasInitialAddress, initialAddressKey, onAddressChange, storageKey]
  )

  const startNewConversation = useCallback(() => {
    setComposeNew(current => !current)
    setSessionKey(key => key + 1)
  }, [])
  const renderNewTaskComposer = (
    instanceId: string,
    testId: string,
    options: { expanded?: boolean; key?: number; startFresh?: boolean } = {}
  ) => {
    const composer = (projectWork?: Parameters<typeof TemporaryChatPanel>[0]['projectWork']) => (
      <AutomaticIssueTaskComposer
        key={options.key}
        project={selectedLocalProject}
        deviceWorkspaceId={localDeviceWorkspaceId}
        projectWork={projectWork}
        inheritFromTask={inheritFromTask}
        taskRequest={taskRequest}
        runtimeContext={runtimeContext}
        prepareTask={prepareTask}
        onTaskCreated={onTaskCreated}
        panelProps={{
          source: null,
          instanceId,
          testId,
          initialInput: initialTaskInput,
          initialAddress: options.startFresh ? null : currentAddress,
          onAddressChange: rememberAddress,
          runtimeContext,
          allowInitialGoal: true,
          emptyStateText: t(
            'todo.issue_task_composer_empty',
            '描述这个任务要完成什么，发送后会创建任务并关联当前 Issue。'
          ),
          placeholder: t('todo.issue_task_composer_placeholder', '描述要执行的任务'),
          expanded: options.expanded,
          wideComposer: options.expanded,
          showProjectWorkBar: Boolean(projectWork),
          projectWorkBarMiddleContext: (
            <WorkItemComposerGuide integrated toolbar project={project} />
          ),
          projectWorkBarTrailingContext: (
            <WorkbenchHarnessSelector
              runtime="codex"
              harnesses={[]}
              enabledHarnesses={[]}
              loading={false}
              detectionFailed={false}
              onRuntimeChange={() => undefined}
            />
          ),
        }}
      />
    )

    return selectedLocalProject ? (
      <ConnectedIssueProjectWork
        project={selectedLocalProject}
        selectedDeviceWorkspaceId={localDeviceWorkspaceId}
        onSelectProject={selectLocalProject}
        onSelectProjectWorkspace={selectLocalProjectWorkspace}
        inheritFromTask={inheritFromTask}
      >
        {projectWork => composer(projectWork)}
      </ConnectedIssueProjectWork>
    ) : (
      composer()
    )
  }

  if (initialAddress) {
    if (embedded) {
      return (
        <IssueTaskConversationPanel
          issueId={task?.id}
          open={open}
          existingTask={true}
          executionDeviceName={executionDeviceName}
          onClose={onClose}
          onBack={onBack}
          translate={(key, fallback, options) => t(key, { ...options, defaultValue: fallback })}
          onOpenTask={
            onOpenRuntimeTask
              ? () => onOpenRuntimeTask(conversationAddress ?? initialAddress)
              : undefined
          }
        >
          <TemporaryChatPanel
            currentProject={selectedLocalProject}
            source={initialAddress}
            instanceId={`work-item-task:${project.id}:${task?.id ?? 'project'}:${initialAddress.deviceId}:${initialAddress.taskId}`}
            testId="work-item-task-chat-panel"
            initialAddress={conversationAddress}
            onAddressChange={rememberAddress}
            runtimeContext={runtimeContext}
            sendEphemeral={false}
            emptyStateText={t('workbench.task_conversation_empty', '该任务还没有对话记录。')}
            placeholder={t('workbench.quick_reply_task', '快速回复这个任务')}
            expanded
          />
        </IssueTaskConversationPanel>
      )
    }

    const statusLabel = {
      inbox: t('workbench.work_item_status_inbox', '收集箱'),
      pending: t('workbench.work_item_status_pending', '待开始'),
      in_progress: t('workbench.work_item_status_in_progress', '进行中'),
      in_review: t('workbench.work_item_status_in_review', '待确认'),
      completed: t('workbench.work_item_status_completed', '已完成'),
    }[task?.status ?? 'pending']

    return (
      <div
        data-testid="ai-chat-modal-backdrop"
        className={cn(
          'fixed inset-x-0 bottom-0 top-[38px] z-critical bg-background',
          !open && 'hidden'
        )}
      >
        <section
          data-testid="ai-chat-modal"
          className="grid h-full min-h-0 grid-cols-[minmax(320px,38%)_minmax(0,1fr)]"
        >
          <aside
            data-testid="work-item-task-context"
            className="flex min-h-0 flex-col border-r border-border bg-background"
          >
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
              <button
                type="button"
                data-testid="ai-chat-modal-close"
                onClick={onClose}
                aria-label={t('workbench.back_to_work_item', '返回工作空间')}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
              >
                <X className="h-4 w-4" />
              </button>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                {t('workbench.work_item_detail', 'Issue 详情')}
              </span>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span>{project.name}</span>
                <span>·</span>
                <span>{task?.id}</span>
                <span>·</span>
                <span>{statusLabel}</span>
              </div>
              <h2 className="mt-3 text-heading-md font-medium leading-tight text-text-primary">
                {task?.title}
              </h2>
              {task?.description ? (
                <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-text-secondary">
                  {task.description}
                </p>
              ) : null}
              <dl className="mt-6 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-3 border-t border-border pt-5 text-sm">
                <dt className="text-text-muted">{t('workbench.runtime_task', '执行任务')}</dt>
                <dd className="truncate text-text-primary">{taskTitle || initialAddress.taskId}</dd>
                <dt className="text-text-muted">{t('workbench.device', '设备')}</dt>
                <dd className="truncate text-text-primary" data-testid="ai-chat-execution-device">
                  {executionDeviceName || initialAddress.deviceId}
                </dd>
              </dl>
            </div>
          </aside>

          <div className="flex min-h-0 min-w-0 flex-col bg-background">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
              <MessageSquare className="h-4 w-4 text-text-secondary" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                {taskTitle || t('workbench.task_conversation', '任务对话')}
              </span>
              {onOpenRuntimeTask ? (
                <button
                  type="button"
                  data-testid="ai-chat-open-runtime-task"
                  onClick={() => void onOpenRuntimeTask(conversationAddress ?? initialAddress)}
                  className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-text-primary transition hover:bg-muted"
                >
                  {t('workbench.open_full_task', '打开完整任务')}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </header>
            <TemporaryChatPanel
              currentProject={selectedLocalProject}
              source={initialAddress}
              instanceId={`work-item-task:${project.id}:${task?.id ?? 'project'}:${initialAddress.deviceId}:${initialAddress.taskId}`}
              testId="work-item-task-chat-panel"
              initialAddress={conversationAddress}
              onAddressChange={rememberAddress}
              runtimeContext={runtimeContext}
              sendEphemeral={false}
              emptyStateText={t('workbench.task_conversation_empty', '该任务还没有对话记录。')}
              placeholder={t('workbench.quick_reply_task', '快速回复这个任务')}
              expanded
            />
          </div>
        </section>
      </div>
    )
  }

  if (embedded) {
    return (
      <IssueTaskConversationPanel
        issueId={task?.id}
        open={open}
        existingTask={false}
        onClose={onClose}
        onBack={onBack}
        translate={(key, fallback, options) => t(key, { ...options, defaultValue: fallback })}
      >
        {renderNewTaskComposer(
          `work-item-new-task:${project.id}:${task?.id ?? 'project'}`,
          'work-item-new-task-chat-panel',
          { expanded: true, startFresh: true }
        )}
      </IssueTaskConversationPanel>
    )
  }

  return (
    <div
      data-testid="ai-chat-modal-backdrop"
      className={cn(
        'fixed inset-0 z-critical flex items-center justify-center bg-black/40 p-6',
        !open && 'hidden'
      )}
      onMouseDown={event => {
        if (event.currentTarget === event.target) onClose()
      }}
    >
      <section
        data-testid="ai-chat-modal"
        className="flex h-[80vh] max-h-[820px] w-[880px] max-w-full flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <Bot className="h-4 w-4 shrink-0 text-violet-600" />
          <span className="text-sm font-semibold text-text-primary">
            {t('workbench.project_chat')}
          </span>
          {task ? (
            <span className="min-w-0 truncate text-xs text-text-muted">
              {task.id} · {task.title}
            </span>
          ) : null}
          <label className="relative ml-2 flex h-[26px] max-w-[200px] shrink-0 items-center rounded-full bg-muted/60 transition-colors hover:bg-muted">
            <span className="sr-only">{t('workbench.project_space_chat.runtime_project')}</span>
            <select
              data-testid="ai-chat-runtime-project"
              value={selectedLocalProject?.id ?? ''}
              onChange={event =>
                setLocalProjectId(event.target.value ? Number(event.target.value) : null)
              }
              className="h-full w-full appearance-none truncate rounded-full bg-transparent pl-2.5 pr-[22px] text-xs text-text-primary outline-none"
            >
              <option value="">{t('workbench.project_space_chat.no_runtime_project')}</option>
              {localProjects.map(localProject => (
                <option key={localProject.id} value={localProject.id}>
                  {t('workbench.project_space_chat.runtime_project_prefix', {
                    name: localProject.name,
                  })}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-[7px] h-[11px] w-[11px] text-text-muted" />
          </label>
          <span className="flex-1" />
          <button
            type="button"
            data-testid="ai-chat-new-conversation"
            title={
              composeNew
                ? t('workbench.project_space_chat.back_to_conversation')
                : t('workbench.project_space_chat.new_conversation')
            }
            aria-label={
              composeNew
                ? t('workbench.project_space_chat.back_to_conversation')
                : t('workbench.project_space_chat.new_conversation')
            }
            onClick={startNewConversation}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
          >
            {composeNew ? <Undo2 className="h-3.5 w-3.5" /> : <Plus className="h-4 w-4" />}
          </button>
          <button
            type="button"
            data-testid="ai-chat-modal-close"
            onClick={onClose}
            aria-label={t('workbench.project_chat_close')}
            className="-mr-1 flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {renderNewTaskComposer(
          `ai-chat:${project.id}:${task?.id ?? 'project'}:${sessionKey}`,
          'ai-chat-panel',
          { key: sessionKey, startFresh: composeNew }
        )}
      </section>
    </div>
  )
}
