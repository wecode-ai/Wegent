import { usePanelResizeDrag } from '@/components/layout/usePanelResizeDrag'
import { SearchableSelect } from '@wegent/collaboration/controls/SearchableSelect'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ChevronDown, MessageSquare, Plus, Undo2, X } from 'lucide-react'
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import type { CloudProject } from '@/api/deliveries'
import { formatRelativeSidebarTime } from '@/components/layout/runtimeSidebarTime'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { Tooltip } from '@/components/ui/tooltip'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
} from '@/types/api'
import { projectSpaceChatRuntimeContext } from './projectProviderConfig'
import { useProjectRuntimeTaskComposer } from './useProjectRuntimeTaskComposer'

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
  localExecution?: boolean
  startNew?: boolean
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
  project: CloudProject
): ProjectSpaceConversation[] {
  return workspaces
    .flatMap(workspace =>
      workspace.tasks.flatMap(task => {
        if (runtimeCloudProjectId(task) !== String(project.id)) return []
        const origin = task.runtimeHandle?.origin as { projectStore?: string } | undefined
        if ((origin?.projectStore === 'local') !== (project.project_store === 'local')) return []
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

function lastConversationStorageKey(project: CloudProject): string {
  return `wework-project-space-chat:${project.project_store}:${project.id}`
}

function ProjectSpaceConversationFrame(props: ComponentProps<typeof TemporaryChatPanel>) {
  const { projectChat } = useWorkbenchPaneContext()
  const { onAddressChange: rememberAddress } = props
  const active = useRef(true)
  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const onAddressChange = useCallback(
    (address: RuntimeTaskAddress | null) => {
      if (active.current) rememberAddress?.(address)
    },
    [rememberAddress]
  )
  // Runtime discovery binds the same frame to its new task; it does not replace the composer.
  const [instanceId] = useState(props.instanceId)
  const draftKey = `pane:${props.instanceId}`
  const draftKeyRef = useRef(draftKey)
  const [value, setValue] = useState(() => projectChat.inputByScope[draftKey] ?? '')
  const writeDraft = projectChat.setInputForScope
  useLayoutEffect(() => {
    const previousKey = draftKeyRef.current
    if (previousKey === draftKey) return
    draftKeyRef.current = draftKey
    writeDraft(draftKey, value)
    writeDraft(previousKey, '')
  }, [draftKey, value, writeDraft])
  const onChange = useCallback(
    (value: string) => {
      setValue(value)
      writeDraft(draftKeyRef.current, value)
    },
    [writeDraft]
  )
  return (
    <TemporaryChatPanel
      {...props}
      instanceId={instanceId}
      draft={{ value, onChange }}
      onAddressChange={onAddressChange}
    />
  )
}

export function ProjectSpaceChatSidebar({
  project,
  localProjects,
  onClose,
  localExecution = false,
  startNew = false,
}: ProjectSpaceChatSidebarProps) {
  const { t } = useTranslation('common')
  const { state, services } = useWorkbenchPaneContext()
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
        project
      ),
    [project, state.runtimeWork]
  )
  const [localProjectId, setLocalProjectId] = useState<number | null>(
    localExecution ? null : (localProjects[0]?.id ?? null)
  )
  const [selectedConversationKey, setSelectedConversationKey] = useState<string | null>(() =>
    window.localStorage.getItem(lastConversationStorageKey(project))
  )
  const [creatingNew, setCreatingNew] = useState(startNew)
  const [createdAddress, setCreatedAddress] = useState<RuntimeTaskAddress | null>(null)
  const [chatInstance, setChatInstance] = useState(0)
  const [width, setWidth] = useState(storedProjectChatWidth)
  const { startResize, stopResize } = usePanelResizeDrag()
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false)
  const [conversationAnchor, setConversationAnchor] = useState<HTMLButtonElement | null>(null)

  const selectedConversation = creatingNew
    ? null
    : (conversations.find(conversation => conversation.key === selectedConversationKey) ??
      (createdAddress ? null : conversations[0]) ??
      null)
  const effectiveLocalProjectId = selectedConversation?.localProjectId ?? localProjectId
  const selectedLocalProject =
    localProjects.find(candidate => candidate.id === effectiveLocalProjectId) ?? null
  const showsNewConversationControls =
    creatingNew || (!createdAddress && selectedConversation === null)

  const selectConversation = useCallback(
    (key: string) => {
      setCreatingNew(false)
      setCreatedAddress(null)
      setSelectedConversationKey(key)
      setChatInstance(current => current + 1)
      window.localStorage.setItem(lastConversationStorageKey(project), key)
    },
    [project]
  )

  const startNewConversation = useCallback(() => {
    setCreatingNew(current => !current)
    setCreatedAddress(null)
    if (!creatingNew) setSelectedConversationKey(null)
    setChatInstance(instance => instance + 1)
  }, [creatingNew])

  const rememberAddress = useCallback(
    (address: RuntimeTaskAddress | null) => {
      if (!address) return
      const key = `${address.deviceId}:${address.taskId}`
      setCreatedAddress(address)
      setCreatingNew(false)
      setSelectedConversationKey(key)
      window.localStorage.setItem(lastConversationStorageKey(project), key)
    },
    [project]
  )

  const runtimeContext = useMemo<
    Pick<RuntimeSendRequest, 'cloudProjectId' | 'origin' | 'additionalContext'>
  >(
    () => ({
      cloudProjectId: String(project.id),
      origin: {
        type: 'project_chat',
        cloudProjectId: String(project.id),
        projectStore: project.project_store === 'local' ? 'local' : 'backend',
      },
      additionalContext: projectSpaceChatRuntimeContext(project),
    }),
    [project]
  )
  const resolveLocalDeviceId = useCallback(async () => {
    const identity = await services.getLocalRuntimeSidebarIdentity?.()
    if (!identity?.deviceId) throw new Error(t('standIn.errors.workspace_unavailable'))
    return identity.deviceId
  }, [services, t])
  const createRuntimeConversation = useProjectRuntimeTaskComposer({
    resolveDeviceId: localExecution ? resolveLocalDeviceId : undefined,
    project: selectedLocalProject,
    workspaceExecution: null,
    runtimeContext,
  })

  const createConversation = useCallback<
    NonNullable<ComponentProps<typeof TemporaryChatPanel>['createTask']>
  >(
    (...args) => {
      setCreatingNew(true)
      return createRuntimeConversation(...args)
    },
    [createRuntimeConversation]
  )

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    stopResize()
    const startWidth = width
    const startX = event.clientX
    const parentWidth =
      event.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width ?? 0
    const maximumWidth = Math.max(PROJECT_CHAT_MIN_WIDTH, parentWidth - PROJECT_CHAT_MAIN_MIN_WIDTH)
    let nextWidth = width
    startResize(event, {
      cursor: 'col-resize',
      onMove: ({ x }) => {
        nextWidth = Math.min(
          Math.max(startWidth + startX - x, PROJECT_CHAT_MIN_WIDTH),
          maximumWidth
        )
        setWidth(nextWidth)
      },
      onEnd: () => window.localStorage.setItem(PROJECT_CHAT_WIDTH_STORAGE_KEY, String(nextWidth)),
    })
  }

  return (
    <aside
      data-testid="project-space-chat-sidebar"
      className="relative flex min-h-0 min-w-0 max-w-full shrink-0 flex-col border-l border-border bg-background max-md:absolute max-md:inset-0 max-md:z-20 max-md:w-full md:w-[var(--project-chat-width)]"
      style={{ '--project-chat-width': `${width}px` } as CSSProperties}
    >
      <div
        data-testid="project-space-chat-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('workbench.project_space_chat.resize')}
        className="absolute bottom-0 left-[-4px] top-0 z-critical w-2 cursor-col-resize touch-none bg-transparent after:absolute after:bottom-0 after:left-1/2 after:top-0 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-primary/40"
        onPointerDown={handleResizeStart}
      />
      <header
        data-testid="project-space-chat-header"
        className="relative flex h-[52px] shrink-0 items-center gap-0.5 border-b border-border px-1.5"
      >
        <Tooltip label={t('workbench.project_space_chat.conversation')} side="bottom" align="start">
          <ControlButton
            variant="unstyled"
            type="button"
            ref={setConversationAnchor}
            data-testid="project-space-chat-menu"
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
          </ControlButton>
        </Tooltip>

        <div className="flex min-w-0 flex-1 items-center">
          {showsNewConversationControls && localExecution ? (
            <span className="truncate pl-2 text-sm font-medium text-text-primary">
              {project.name}
            </span>
          ) : showsNewConversationControls ? (
            <>
              <span className="shrink-0 pl-2 text-sm font-medium text-text-primary">
                {t('workbench.project_space_chat.new_conversation_option')}
              </span>
              <SelectField
                testId="project-space-chat-runtime-project"
                accessibleLabel={t('workbench.project_space_chat.runtime_project')}
                value={String(selectedLocalProject?.id ?? '')}
                options={[
                  { value: '', label: t('workbench.project_space_chat.no_runtime_project') },
                  ...localProjects.map(project => ({
                    value: String(project.id),
                    label: t('workbench.project_space_chat.runtime_project_prefix', {
                      name: project.name,
                    }),
                  })),
                ]}
                onChange={value => setLocalProjectId(value ? Number(value) : null)}
                className="ml-1.5 max-w-48 shrink-0"
              />
            </>
          ) : (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="project-space-chat-conversation"
              onClick={event => {
                setConversationAnchor(event.currentTarget)
                setConversationMenuOpen(true)
              }}
              className="min-w-0 flex-1 justify-start"
            >
              <span className="truncate">
                {selectedConversation?.task.title ??
                  t('workbench.project_space_chat.new_conversation_option')}
              </span>
              <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
            </ControlButton>
          )}
        </div>

        <Tooltip
          label={
            creatingNew
              ? t('workbench.project_space_chat.back_to_conversation')
              : t('workbench.project_space_chat.new_conversation')
          }
          side="bottom"
          align="end"
        >
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="project-space-chat-new"
            aria-label={
              creatingNew
                ? t('workbench.project_space_chat.back_to_conversation')
                : t('workbench.project_space_chat.new_conversation')
            }
            onClick={startNewConversation}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
          >
            {creatingNew ? <Undo2 className="h-3.5 w-3.5" /> : <Plus className="h-4 w-4" />}
          </ControlButton>
        </Tooltip>
        <Tooltip label={t('workbench.project_space_chat.close')} side="bottom" align="end">
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="project-space-chat-close"
            onClick={onClose}
            aria-label={t('workbench.project_space_chat.close')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-muted hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </ControlButton>
        </Tooltip>

        <SearchableSelect
          hideTrigger
          anchor={conversationAnchor}
          testId="project-space-chat-conversation"
          menuTestId="project-space-chat-menu-list"
          header={
            <p className="px-2.5 pb-1 pt-1.5 text-xs text-text-secondary">
              {t('workbench.project_space_chat.menu_title', { name: project.name })}
            </p>
          }
          accessibleLabel={t('workbench.project_space_chat.menu_title', { name: project.name })}
          value={selectedConversation?.key ?? ''}
          options={conversations.map(conversation => ({
            value: conversation.key,
            label: conversation.task.title,
            description: formatRelativeSidebarTime(
              conversation.task.updatedAt ?? conversation.task.createdAt ?? undefined
            ),
            testId: 'project-space-chat-menu-item',
          }))}
          onChange={selectConversation}
          open={conversationMenuOpen}
          onOpenChange={setConversationMenuOpen}
          searchPlaceholder={t('workbench.search_conversations')}
          emptyLabel={t('workbench.project_space_chat.new_conversation_option')}
          actions={[
            {
              label: t('workbench.project_space_chat.new_conversation'),
              testId: 'project-space-chat-menu-new',
              icon: <Plus className="h-4 w-4" />,
              onSelect: startNewConversation,
            },
          ]}
        />
      </header>

      <p
        data-testid="project-space-chat-capabilities"
        className="shrink-0 px-4 py-2 text-sm text-text-secondary"
      >
        {t('workbench.project_space_chat.capabilities', { name: project.name })}
      </p>

      <ProjectSpaceConversationFrame
        key={`${project.project_store}:${project.id}:${chatInstance}:${creatingNew || createdAddress ? 'new' : (selectedConversation?.key ?? 'new')}`}
        currentProject={selectedLocalProject}
        source={null}
        instanceId={`project-space:${project.project_store}:${project.id}:${createdAddress ? `${createdAddress.deviceId}:${createdAddress.taskId}` : (selectedConversation?.key ?? 'new')}`}
        testId="project-space-chat-panel"
        initialAddress={selectedConversation?.address ?? createdAddress}
        createTask={createConversation}
        runtimeContext={runtimeContext}
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
