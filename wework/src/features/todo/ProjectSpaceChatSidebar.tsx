import { Check, ChevronDown, MessageSquare, Plus, Undo2, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { formatRelativeSidebarTime } from '@/components/layout/runtimeSidebarTime'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type { CloudProject } from '@/api/deliveries'
import type {
  Attachment,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
} from '@/types/api'
import { projectSpaceChatRuntimeContext } from './projectProviderConfig'

interface ProjectSpaceConversation {
  key: string
  address: RuntimeTaskAddress
  task: RuntimeTaskSummary
  localProjectId: number | null
}

interface ProjectSpaceChatSidebarProps {
  project: CloudProject
  localProjects: ProjectWithTasks[]
  onClose: () => void
}

const PROJECT_CHAT_DEFAULT_WIDTH = 420
const PROJECT_CHAT_MIN_WIDTH = 320
const PROJECT_CHAT_MAIN_MIN_WIDTH = 360
const PROJECT_CHAT_WIDTH_STORAGE_KEY = 'wework.project-space-chat-width'

function storedProjectChatWidth(): number {
  const value = Number(window.localStorage.getItem(PROJECT_CHAT_WIDTH_STORAGE_KEY))
  return Number.isFinite(value) && value >= PROJECT_CHAT_MIN_WIDTH
    ? value
    : PROJECT_CHAT_DEFAULT_WIDTH
}

function runtimeCloudProjectId(task: RuntimeTaskSummary): string | null {
  const value = task.runtimeHandle?.cloudProjectId ?? task.runtimeHandle?.cloud_project_id
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

function taskTimestamp(task: RuntimeTaskSummary): number {
  const value = task.updatedAt ?? task.createdAt
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Date.parse(value) || 0
  return 0
}

function projectSpaceConversations(
  workspaces: RuntimeDeviceWorkspace[],
  projectId: string
): ProjectSpaceConversation[] {
  return workspaces
    .flatMap(workspace =>
      workspace.tasks.flatMap(task => {
        if (runtimeCloudProjectId(task) !== projectId) return []
        const address: RuntimeTaskAddress = {
          deviceId: workspace.deviceId,
          taskId: task.taskId,
          workspacePath: task.workspacePath || workspace.workspacePath,
          ...(task.runtimeHandle ? { runtimeHandle: task.runtimeHandle } : {}),
        }
        return [
          {
            key: `${workspace.deviceId}:${task.taskId}`,
            address,
            task,
            localProjectId: workspace.projectId ?? null,
          },
        ]
      })
    )
    .sort((left, right) => taskTimestamp(right.task) - taskTimestamp(left.task))
}

function lastConversationStorageKey(projectId: string): string {
  return `wework-project-space-chat:${projectId}`
}

export function ProjectSpaceChatSidebar({
  project,
  localProjects,
  onClose,
}: ProjectSpaceChatSidebarProps) {
  const { t } = useTranslation('common')
  const { state, createProjectRuntimeTask } = useWorkbenchPaneContext()
  const conversations = useMemo(
    () =>
      projectSpaceConversations(
        state.runtimeWork
          ? [
              ...state.runtimeWork.projects.flatMap(item =>
                item.deviceWorkspaces.map(workspace => ({
                  ...workspace,
                  projectId: workspace.projectId ?? item.project.id,
                }))
              ),
              ...state.runtimeWork.chats,
            ]
          : [],
        String(project.id)
      ),
    [project.id, state.runtimeWork]
  )
  const [localProjectId, setLocalProjectId] = useState<number | null>(localProjects[0]?.id ?? null)
  const [selectedConversationKey, setSelectedConversationKey] = useState<string | null>(() =>
    window.localStorage.getItem(lastConversationStorageKey(String(project.id)))
  )
  const [creatingNew, setCreatingNew] = useState(false)
  const [chatInstance, setChatInstance] = useState(0)
  const [width, setWidth] = useState(storedProjectChatWidth)
  const [resizing, setResizing] = useState(false)
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false)
  const conversationMenuRef = useRef<HTMLDivElement>(null)
  const resizeStartRef = useRef({ pointerX: 0, width: PROJECT_CHAT_DEFAULT_WIDTH })
  const resizedWidthRef = useRef(width)

  useEffect(() => {
    if (!conversationMenuOpen) return

    function handlePointerDown(event: PointerEvent) {
      if (!conversationMenuRef.current?.contains(event.target as Node)) {
        setConversationMenuOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setConversationMenuOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [conversationMenuOpen])

  const selectedConversation = creatingNew
    ? null
    : (conversations.find(conversation => conversation.key === selectedConversationKey) ??
      conversations[0] ??
      null)
  const effectiveLocalProjectId = selectedConversation?.localProjectId ?? localProjectId
  const selectedLocalProject =
    localProjects.find(candidate => candidate.id === effectiveLocalProjectId) ?? null
  const showsNewConversationControls = creatingNew || selectedConversation === null

  const selectConversation = useCallback(
    (key: string) => {
      setCreatingNew(false)
      setSelectedConversationKey(key)
      setChatInstance(current => current + 1)
      window.localStorage.setItem(lastConversationStorageKey(String(project.id)), key)
    },
    [project.id]
  )

  const startNewConversation = useCallback(() => {
    setCreatingNew(current => {
      if (current) return false
      setSelectedConversationKey(null)
      setChatInstance(instance => instance + 1)
      return true
    })
  }, [])

  const rememberAddress = useCallback(
    (address: RuntimeTaskAddress | null) => {
      if (!address) return
      const key = `${address.deviceId}:${address.taskId}`
      setCreatingNew(false)
      setSelectedConversationKey(key)
      window.localStorage.setItem(lastConversationStorageKey(String(project.id)), key)
    },
    [project.id]
  )

  const createConversation = useCallback(
    async (
      message: string,
      options: {
        attachments: Attachment[]
        onError: (message: string) => void
        onRuntimeTaskOptimisticOpen: (address: RuntimeTaskAddress) => void
      }
    ) => {
      const address = await createProjectRuntimeTask(message, {
        project: selectedLocalProject,
        attachments: options.attachments,
        collaborationMode: 'default',
        cloudProjectId: String(project.id),
        additionalContext: projectSpaceChatRuntimeContext(project),
        onError: options.onError,
        onRuntimeTaskOptimisticOpen: options.onRuntimeTaskOptimisticOpen,
      })
      return address
    },
    [createProjectRuntimeTask, project, selectedLocalProject]
  )

  const resize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!resizing) return
      const parentWidth =
        event.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width ?? 0
      const maximumWidth = Math.max(
        PROJECT_CHAT_MIN_WIDTH,
        parentWidth - PROJECT_CHAT_MAIN_MIN_WIDTH
      )
      const nextWidth = Math.min(
        Math.max(
          resizeStartRef.current.width + resizeStartRef.current.pointerX - event.clientX,
          PROJECT_CHAT_MIN_WIDTH
        ),
        maximumWidth
      )
      resizedWidthRef.current = nextWidth
      setWidth(nextWidth)
    },
    [resizing]
  )

  const finishResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!resizing) return
      setResizing(false)
      window.localStorage.setItem(PROJECT_CHAT_WIDTH_STORAGE_KEY, String(resizedWidthRef.current))
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    },
    [resizing]
  )

  return (
    <aside
      data-testid="project-space-chat-sidebar"
      className="relative flex min-w-0 shrink-0 flex-col border-l border-border bg-background"
      style={{ width }}
    >
      <div
        data-testid="project-space-chat-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('workbench.project_space_chat.resize')}
        className="absolute bottom-0 left-[-4px] top-0 z-critical w-2 cursor-col-resize touch-none bg-transparent after:absolute after:bottom-0 after:left-1/2 after:top-0 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-primary/40"
        onPointerDown={event => {
          event.preventDefault()
          resizeStartRef.current = { pointerX: event.clientX, width }
          resizedWidthRef.current = width
          setResizing(true)
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }}
        onPointerMove={resize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
      />
      <header
        data-testid="project-space-chat-header"
        className="relative flex h-[52px] shrink-0 items-center gap-0.5 border-b border-border px-1.5"
      >
        <button
          type="button"
          data-testid="project-space-chat-menu"
          title={t('workbench.project_space_chat.conversation')}
          aria-label={t('workbench.project_space_chat.conversation')}
          aria-expanded={conversationMenuOpen}
          onClick={() => setConversationMenuOpen(open => !open)}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
            conversationMenuOpen
              ? 'bg-muted text-text-primary'
              : 'text-text-secondary hover:bg-muted hover:text-text-primary'
          }`}
        >
          <MessageSquare className="h-4 w-4" />
        </button>

        <div className="flex min-w-0 flex-1 items-center">
          {showsNewConversationControls ? (
            <>
              <span className="shrink-0 pl-2 text-sm font-medium text-text-primary">
                {t('workbench.project_space_chat.new_conversation_option')}
              </span>
              <label className="relative ml-1.5 flex h-[26px] max-w-[180px] shrink-0 items-center rounded-full bg-muted/60 transition-colors hover:bg-muted">
                <span className="sr-only">{t('workbench.project_space_chat.runtime_project')}</span>
                <select
                  data-testid="project-space-chat-runtime-project"
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
            </>
          ) : (
            <button
              type="button"
              data-testid="project-space-chat-conversation"
              onClick={() => setConversationMenuOpen(open => !open)}
              className="flex h-7 min-w-0 flex-1 items-center gap-0.5 rounded-md py-0 pl-2 pr-1 text-left transition-colors hover:bg-muted"
            >
              <span className="truncate text-sm font-normal text-text-primary">
                {selectedConversation?.task.title ??
                  t('workbench.project_space_chat.new_conversation_option')}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0 text-text-muted" />
            </button>
          )}
        </div>

        <button
          type="button"
          data-testid="project-space-chat-new"
          title={
            creatingNew
              ? t('workbench.project_space_chat.back_to_conversation')
              : t('workbench.project_space_chat.new_conversation')
          }
          aria-label={
            creatingNew
              ? t('workbench.project_space_chat.back_to_conversation')
              : t('workbench.project_space_chat.new_conversation')
          }
          onClick={startNewConversation}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
        >
          {creatingNew ? <Undo2 className="h-3.5 w-3.5" /> : <Plus className="h-4 w-4" />}
        </button>
        <button
          type="button"
          data-testid="project-space-chat-close"
          onClick={onClose}
          title={t('workbench.project_space_chat.close')}
          aria-label={t('workbench.project_space_chat.close')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-muted hover:text-text-primary"
        >
          <X className="h-4 w-4" />
        </button>

        {conversationMenuOpen && (
          <div
            ref={conversationMenuRef}
            data-testid="project-space-chat-menu-list"
            className="absolute left-1.5 top-[38px] z-modal w-[300px] max-w-[calc(100%-12px)] rounded-xl border border-border bg-popover p-1 shadow-lg"
          >
            <p className="px-2.5 pb-1 pt-1.5 text-xs text-text-muted">
              {t('workbench.project_space_chat.menu_title', { name: project.name })}
            </p>
            <div className="max-h-[320px] overflow-y-auto">
              {conversations.map(conversation => {
                const isCurrent = conversation.key === selectedConversation?.key
                return (
                  <button
                    key={conversation.key}
                    type="button"
                    data-testid="project-space-chat-menu-item"
                    onClick={() => {
                      selectConversation(conversation.key)
                      setConversationMenuOpen(false)
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-muted"
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-sm ${
                          isCurrent ? 'font-medium text-text-primary' : 'text-text-primary'
                        }`}
                      >
                        {conversation.task.title}
                      </span>
                      <span className="block truncate text-xs text-text-muted">
                        {formatRelativeSidebarTime(
                          conversation.task.updatedAt ?? conversation.task.createdAt ?? undefined
                        )}
                      </span>
                    </span>
                    {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-text-secondary" />}
                  </button>
                )
              })}
              {conversations.length > 0 && <div className="mx-2 my-1 h-px bg-border" />}
              <button
                type="button"
                data-testid="project-space-chat-menu-new"
                onClick={() => {
                  startNewConversation()
                  setConversationMenuOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-text-primary transition-colors hover:bg-muted"
              >
                <Plus className="h-3.5 w-3.5 text-text-muted" />
                {t('workbench.project_space_chat.new_conversation')}
              </button>
            </div>
          </div>
        )}
      </header>

      <TemporaryChatPanel
        key={`${project.id}:${chatInstance}`}
        currentProject={selectedLocalProject}
        source={null}
        instanceId={`project-space:${project.id}:${selectedConversation?.key ?? 'new'}`}
        testId="project-space-chat-panel"
        initialAddress={selectedConversation?.address ?? null}
        createTask={createConversation}
        onAddressChange={rememberAddress}
        sendEphemeral={false}
        emptyStateText={
          selectedConversation
            ? t('workbench.project_space_chat.empty_existing')
            : t('workbench.project_space_chat.empty_new', { name: project.name })
        }
        placeholder={t('workbench.project_space_chat.placeholder')}
      />
    </aside>
  )
}
