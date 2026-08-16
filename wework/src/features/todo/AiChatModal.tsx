import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  ChevronDown,
  MessageSquare,
  Plus,
  Undo2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  Attachment,
  ModelOptions,
  ModelType,
  ProjectWithTasks,
  RuntimeTaskAddress,
} from '@/types/api'
import { projectSpaceChatRuntimeContext } from './projectProviderConfig'

interface AiChatModalProps {
  project: CloudProject
  localProjects: ProjectWithTasks[]
  task?: CloudLoopItem
  /** When false the panel stays mounted (conversation state and stream keep
   * running) but the overlay is hidden, so reopening shows the last messages
   * even while the temporary task is still executing. */
  open: boolean
  onClose: () => void
  initialAddress?: RuntimeTaskAddress | null
  taskTitle?: string | null
  initialTaskInput?: string
  autoSubmitInitialTaskInput?: boolean
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onAddressChange?: (address: RuntimeTaskAddress) => void
  embedded?: boolean
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
  initialAddress = null,
  taskTitle,
  initialTaskInput = '',
  autoSubmitInitialTaskInput = false,
  onOpenRuntimeTask,
  onAddressChange,
  embedded = false,
}: AiChatModalProps) {
  const { t } = useTranslation('common')
  const { createProjectRuntimeTask } = useWorkbenchPaneContext()
  const storageKey = lastAddressStorageKey(project.id, task?.id)
  const [currentAddress, setCurrentAddress] = useState<RuntimeTaskAddress | null>(
    () => initialAddress ?? storedLastAddress(storageKey)
  )
  // Compose a fresh temporary task (panel remounts without a saved address)
  // or return to the current conversation. The panel only reads the address on
  // mount, so explicit toggles bump the remount key; creating a new runtime
  // task must NOT remount (the panel already switched to it internally).
  const [composeNew, setComposeNew] = useState(false)
  const [sessionKey, setSessionKey] = useState(0)
  const [localProjectId, setLocalProjectId] = useState<number | null>(() => {
    const matched =
      localProjects.find(candidate => String(candidate.id) === String(project.id)) ??
      localProjects[0]
    return matched?.id ?? null
  })
  const selectedLocalProject =
    localProjects.find(candidate => candidate.id === localProjectId) ?? null

  // The task detail modal stays open underneath; Escape only closes the chat
  // first so the user never loses the task context in one keystroke.
  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  const createConversation = useCallback(
    async (
      message: string,
      options: {
        attachments: Attachment[]
        executionModel: {
          modelId?: string
          modelType?: ModelType | null
          modelOptions?: ModelOptions
        }
        onError: (message: string) => void
        onRuntimeTaskOptimisticOpen: (address: RuntimeTaskAddress) => void
      }
    ) => {
      const address = await createProjectRuntimeTask(message, {
        project: selectedLocalProject,
        runtime: 'codex',
        attachments: options.attachments,
        executionModel: options.executionModel,
        collaborationMode: 'default',
        cloudProjectId: String(project.id),
        additionalContext: {
          ...projectSpaceChatRuntimeContext(project),
          ...(task
            ? {
                projectChatTask: {
                  kind: 'application',
                  value: [
                    '<current_task>',
                    JSON.stringify({
                      id: String(task.id),
                      title: task.title,
                      description: task.description ?? '',
                      status: task.status,
                    }),
                    '</current_task>',
                    'This run is bound to this task in the current project space.',
                  ].join('\n'),
                },
              }
            : {}),
        },
        onError: options.onError,
        onRuntimeTaskOptimisticOpen: options.onRuntimeTaskOptimisticOpen,
      })
      return address
    },
    [createProjectRuntimeTask, project, selectedLocalProject, task]
  )

  const rememberAddress = useCallback(
    (address: RuntimeTaskAddress | null) => {
      if (!address) return
      window.localStorage.setItem(storageKey, JSON.stringify(address))
      setCurrentAddress(address)
      setComposeNew(false)
      onAddressChange?.(address)
    },
    [onAddressChange, storageKey]
  )

  const startNewConversation = useCallback(() => {
    setComposeNew(current => !current)
    setSessionKey(key => key + 1)
  }, [])

  if (initialAddress) {
    if (embedded) {
      return (
        <aside
          data-testid="ai-chat-modal-backdrop"
          className={cn(
            'relative z-10 flex h-full min-h-0 w-[min(620px,38vw)] min-w-[460px] shrink-0 flex-col border-l border-border bg-background',
            !open && 'hidden'
          )}
        >
          <section data-testid="ai-chat-modal" className="flex h-full min-h-0 min-w-0 flex-col">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
              <button
                type="button"
                data-testid="ai-chat-modal-close"
                onClick={onClose}
                aria-label={t('workbench.back_to_work_item', '返回 Issue')}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-xs text-text-muted">
                  {task?.id} · {t('workbench.task_conversation', '任务会话')}
                </div>
                <div className="truncate text-sm font-medium text-text-primary">
                  {taskTitle || initialAddress.taskId}
                </div>
              </div>
              {onOpenRuntimeTask ? (
                <button
                  type="button"
                  data-testid="ai-chat-open-runtime-task"
                  onClick={() => void onOpenRuntimeTask(initialAddress)}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-sm text-text-primary transition hover:bg-muted"
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
              initialAddress={currentAddress}
              onAddressChange={rememberAddress}
              sendEphemeral={false}
              emptyStateText={t('workbench.task_conversation_empty', '该任务还没有对话记录。')}
              placeholder={t('workbench.quick_reply_task', '快速回复这个任务')}
              expanded
            />
          </section>
        </aside>
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
                <dd className="truncate text-text-primary">{initialAddress.deviceId}</dd>
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
                  onClick={() => void onOpenRuntimeTask(initialAddress)}
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
              initialAddress={currentAddress}
              onAddressChange={rememberAddress}
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
      <aside
        data-testid="ai-chat-modal-backdrop"
        className={cn(
          'relative z-10 flex h-full min-h-0 w-[min(620px,38vw)] min-w-[460px] shrink-0 flex-col border-l border-border bg-background',
          !open && 'hidden'
        )}
      >
        <section data-testid="ai-chat-modal" className="flex h-full min-h-0 min-w-0 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
            <button
              type="button"
              data-testid="ai-chat-modal-close"
              onClick={onClose}
              aria-label={t('workbench.back_to_work_item', '返回工作空间')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="text-xs text-text-muted">
                {task?.id} · {t('workbench.runtime_task', '任务')}
              </div>
              <div className="truncate text-sm font-medium text-text-primary">新建任务</div>
            </div>
            <label className="relative flex h-8 max-w-44 shrink-0 items-center rounded-lg border border-border bg-background transition hover:bg-muted">
              <span className="sr-only">{t('workbench.project_space_chat.runtime_project')}</span>
              <select
                data-testid="ai-chat-runtime-project"
                value={selectedLocalProject?.id ?? ''}
                onChange={event =>
                  setLocalProjectId(event.target.value ? Number(event.target.value) : null)
                }
                className="h-full w-full appearance-none truncate rounded-lg bg-transparent pl-2.5 pr-7 text-xs text-text-primary outline-none"
              >
                <option value="">{t('workbench.project_space_chat.no_runtime_project')}</option>
                {localProjects.map(localProject => (
                  <option key={localProject.id} value={localProject.id}>
                    {localProject.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-text-muted" />
            </label>
          </header>
          <TemporaryChatPanel
            currentProject={selectedLocalProject}
            source={null}
            instanceId={`work-item-new-task:${project.id}:${task?.id ?? 'project'}`}
            testId="work-item-new-task-chat-panel"
            initialInput={initialTaskInput}
            autoSubmitInitialInput={autoSubmitInitialTaskInput}
            initialAddress={currentAddress}
            createTask={createConversation}
            onAddressChange={rememberAddress}
            emptyStateText="描述这个任务要完成什么，发送后会创建任务并关联当前 Issue。"
            placeholder="描述要执行的任务"
            expanded
          />
        </section>
      </aside>
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
        <TemporaryChatPanel
          key={sessionKey}
          currentProject={selectedLocalProject}
          source={null}
          instanceId={`ai-chat:${project.id}:${task?.id ?? 'project'}:${sessionKey}`}
          testId="ai-chat-panel"
          initialAddress={composeNew ? null : currentAddress}
          createTask={createConversation}
          onAddressChange={rememberAddress}
        />
      </section>
    </div>
  )
}
