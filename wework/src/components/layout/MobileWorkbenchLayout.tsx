import { Bot, Menu } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ChatInput } from '@/components/chat/ChatInput'
import type {
  ProjectChatControls,
  ProjectWorkControls,
} from '@/components/chat/ChatInput'
import { ModelSelector } from '@/components/chat/composer/ModelSelector'
import { ProjectWorkBar } from '@/components/chat/composer/ProjectWorkBar'
import { MobileSettingsPage } from '@/components/settings/MobileSettingsPage'
import { stripAppBasePath } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import { isSettingsRoute, navigateTo } from '@/lib/navigation'
import {
  findWorkbenchDevice,
  getActiveWorkbenchDeviceId,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import {
  isDeviceBelowWeWorkVersion,
  isWeWorkCompatibleDevice,
} from '@/lib/device-capabilities'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import type {
  ArchivedTaskListResponse,
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  GitBranch,
  GitRepoInfo,
  ProjectWithTasks,
} from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type { DeviceUpgradeState } from '@/types/device-events'
import type {
  GuidanceWorkbenchMessage,
  QueuedWorkbenchMessage,
  WorkbenchMessage,
  WorkbenchState,
} from '@/types/workbench'
import { DeviceStatusPrompt } from './DeviceStatusPrompt'
import { MobileDrawer } from './MobileDrawer'

interface MobileWorkbenchLayoutProps {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  queuedMessages?: QueuedWorkbenchMessage[]
  guidanceMessages?: GuidanceWorkbenchMessage[]
  runningTaskIds?: Set<number>
  upgradingDevices?: Record<string, DeviceUpgradeState>
  activeItem?: 'chat' | 'plugins' | 'automation'
  onNewChat?: () => void
  onStartStandaloneChat?: () => void
  onOpenPlugins?: () => void
  projectChat: ProjectChatControls
  projectWork: ProjectWorkControls
  onSelectProject: (projectId: number | null) => void
  onStartNewProjectChat?: (projectId: number) => void
  onOpenTask: (taskId: number, projectId?: number) => void
  onCreateProject?: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onCreateGitWorkspaceProject?: (
    data: CreateGitWorkspaceProjectRequest,
  ) => Promise<ProjectWithTasks>
  onListGitRepositories?: () => Promise<GitRepoInfo[]>
  onListGitBranches?: (repo: GitRepoInfo) => Promise<GitBranch[]>
  onUpdateProjectName?: (projectId: number, name: string) => Promise<void>
  onRemoveProject?: (projectId: number) => Promise<void>
  onArchiveAllChats?: () => Promise<void>
  onArchiveAllProjectChats?: () => Promise<void>
  onArchiveProjectChats?: (projectId: number) => Promise<void>
  onArchiveTask?: (taskId: number) => Promise<void>
  onRenameTask?: (taskId: number, title: string) => Promise<void>
  onListArchivedTasks?: () => Promise<ArchivedTaskListResponse>
  onUnarchiveTask?: (taskId: number) => Promise<void>
  onDeleteTask?: (taskId: number) => Promise<void>
  onDeleteArchivedTasks?: () => Promise<void>
  onGetDeviceHomeDirectory?: (deviceId: string) => Promise<string>
  onGetProjectWorkspaceRoot?: (deviceId: string) => Promise<string>
  onListDeviceDirectories?: (
    deviceId: string,
    path: string,
  ) => Promise<string[]>
  onLoadEnvironmentInfo?: (
    project: ProjectWithTasks | null,
  ) => Promise<EnvironmentInfo>
  onCommitEnvironmentChanges?: (
    project: ProjectWithTasks | null,
    message: string,
  ) => Promise<void>
  onListEnvironmentBranches?: (
    project: ProjectWithTasks | null,
  ) => Promise<string[]>
  onCheckoutEnvironmentBranch?: (
    project: ProjectWithTasks | null,
    branchName: string,
  ) => Promise<void>
  onCreateEnvironmentBranch?: (
    project: ProjectWithTasks | null,
    branchName: string,
  ) => Promise<void>
  onUpgradeDevice?: (deviceId: string) => Promise<void>
  onInputChange: (value: string) => void
  onSend: () => void
  isResponseStreaming?: boolean
  onPauseResponse?: () => void
  onCancelQueuedMessage?: (id: string) => void
  onSendQueuedAsGuidance?: (id: string) => void
  onEditQueuedMessage?: (id: string) => void
  onCancelGuidanceMessage?: (id: string) => void
  onLogout: () => void
}

export function MobileWorkbenchLayout({
  state,
  messages,
  queuedMessages = [],
  guidanceMessages = [],
  runningTaskIds,
  upgradingDevices = {},
  activeItem,
  onNewChat,
  onStartStandaloneChat,
  onOpenPlugins,
  projectChat,
  projectWork,
  onSelectProject,
  onOpenTask,
  onLoadEnvironmentInfo,
  onListEnvironmentBranches,
  onCheckoutEnvironmentBranch,
  onCreateEnvironmentBranch,
  onUpgradeDevice = async () => {},
  onInputChange,
  onSend,
  isResponseStreaming = false,
  onPauseResponse = () => {},
  onCancelQueuedMessage = () => {},
  onSendQueuedAsGuidance = () => {},
  onEditQueuedMessage = () => {},
  onCancelGuidanceMessage = () => {},
}: MobileWorkbenchLayoutProps) {
  const { t } = useTranslation('common')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(() =>
    isSettingsRoute(stripAppBasePath(window.location.pathname))
  )
  const [environmentInfo, setEnvironmentInfo] = useState<EnvironmentInfo>({
    additions: '+0',
    deletions: '-0',
    executionTarget: 'local',
  })
  const hasConversation = messages.length > 0 || state.currentTask
  const effectiveProjectChat = projectChat ?? {
    models: [],
    selectedModel: null,
    selectedModelOptions: {},
    isModelSelectionReady: true,
    isOptionsLocked: false,
    setSelectedModel: () => {},
    setSelectedModelOption: () => {},
  }
  const emptyTitle = state.currentProject
    ? t('workbench.project_empty_title', {
        defaultValue: `我们应该在 ${state.currentProject.name} 中构建什么？`,
        projectName: state.currentProject.name,
      })
    : t('workbench.empty_title', '我们该做什么？')
  const refreshEnvironmentInfo = useCallback(async () => {
    if (!onLoadEnvironmentInfo || !state.currentProject) return

    setEnvironmentInfo(info => ({ ...info, loading: true }))
    try {
      const info = await onLoadEnvironmentInfo(state.currentProject)
      setEnvironmentInfo({ ...info, loading: false })
    } catch (error) {
      setEnvironmentInfo(info => ({
        ...info,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load environment info',
      }))
    }
  }, [onLoadEnvironmentInfo, state.currentProject])

  const baseProjectWork = projectWork ?? {
    projects: state.projects,
    devices: state.devices,
    currentProjectId: state.currentProject?.id,
    currentStandaloneDeviceId: state.standaloneDeviceId,
    executionMode: 'current_workspace',
    executionModeLocked: Boolean(state.currentTask),
    onSelectProject,
    onSelectStandaloneDevice: () => {},
    onExecutionModeChange: () => {},
  }
  const effectiveProjectWork: ProjectWorkControls = {
    ...baseProjectWork,
    branchName: environmentInfo.branchName,
    branchLoading: environmentInfo.loading,
    onRefreshBranch: refreshEnvironmentInfo,
    onListBranches:
      state.currentProject && onListEnvironmentBranches
        ? () => onListEnvironmentBranches(state.currentProject)
        : undefined,
    onCheckoutBranch:
      state.currentProject && onCheckoutEnvironmentBranch
        ? async branchName => {
            await onCheckoutEnvironmentBranch(state.currentProject, branchName)
            await refreshEnvironmentInfo()
          }
        : undefined,
    onCreateBranch:
      state.currentProject && onCreateEnvironmentBranch
        ? async branchName => {
            await onCreateEnvironmentBranch(state.currentProject, branchName)
            await refreshEnvironmentInfo()
          }
        : undefined,
  }
  const activeDeviceId = getActiveWorkbenchDeviceId({
    currentTask: state.currentTask,
    currentProject: state.currentProject,
    standaloneDeviceId: effectiveProjectWork.currentStandaloneDeviceId,
  })
  const activeDevice = findWorkbenchDevice(state.devices, activeDeviceId)
  const activeDeviceUnavailable =
    Boolean(activeDeviceId) && !isWorkbenchDeviceOnline(activeDevice)
  const activeDeviceVersionUnsupported =
    Boolean(activeDevice && isDeviceBelowWeWorkVersion(activeDevice))
  const noStandaloneCompatibleDevice =
    !state.currentProject &&
    !activeDeviceId &&
    !state.devices.some(device => device.status === 'online' && isWeWorkCompatibleDevice(device))
  const composerDisabled =
    state.isSending ||
    activeDeviceUnavailable ||
    activeDeviceVersionUnsupported ||
    noStandaloneCompatibleDevice

  useEffect(() => {
    const handlePopState = () => {
      setSettingsOpen(isSettingsRoute(stripAppBasePath(window.location.pathname)))
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (state.currentProject && !state.currentTask) {
      void refreshEnvironmentInfo()
    }
  }, [refreshEnvironmentInfo, state.currentProject, state.currentTask])

  if (settingsOpen) {
    return (
      <MobileSettingsPage
        onBack={() => {
          setSettingsOpen(false)
          navigateTo('/')
        }}
        onOpenPlugins={onOpenPlugins}
      />
    )
  }

  if (state.isBootstrapping) {
    return (
      <div className="flex h-dvh overflow-hidden bg-background text-text-primary">
        <main
          className="flex h-dvh min-h-0 w-full flex-col overflow-hidden"
          data-testid="mobile-workbench-loading"
        />
      </div>
    )
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-text-primary">
      <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden">
        {hasConversation ? (
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <header
              data-testid="mobile-conversation-header"
              className="pointer-events-none absolute left-0 right-0 top-0 z-chrome flex min-h-[56px] items-center gap-2 border-b border-border/60 bg-background/95 px-3 pb-2 pt-[max(6px,env(safe-area-inset-top))] backdrop-blur"
            >
              <button
                type="button"
                data-testid="open-mobile-drawer-button"
                onClick={() => setDrawerOpen(true)}
                className="pointer-events-auto flex h-11 min-w-[44px] items-center justify-center rounded-full text-text-primary hover:bg-surface"
                aria-label={t('workbench.open_menu', '打开菜单')}
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="pointer-events-auto flex min-w-0 flex-1 justify-start">
                {(effectiveProjectChat.isModelSelectionReady ?? true) ? (
                  <ModelSelector
                    models={effectiveProjectChat.models}
                    selectedModel={effectiveProjectChat.selectedModel}
                    selectedModelOptions={effectiveProjectChat.selectedModelOptions}
                    disabled={false}
                    onSelectModel={effectiveProjectChat.setSelectedModel}
                    onSelectModelOption={effectiveProjectChat.setSelectedModelOption}
                    menuPlacement="below"
                    buttonClassName="max-w-[min(14rem,calc(100vw-6rem))] bg-surface px-3"
                    menuClassName="left-0 right-auto w-[min(34rem,calc(100vw-2rem))]"
                  />
                ) : (
                  <div className="h-10 w-32" data-testid="model-selector-loading" />
                )}
              </div>
              <div className="h-11 min-w-[44px]" />
            </header>
            <ScrollableMessageArea
              messages={messages}
              conversationKey={state.currentTask?.id ?? null}
              className="h-full"
              scrollerClassName="pb-28 pt-16"
            />
            <div
              data-testid="mobile-chat-input-dock"
              className="pointer-events-none absolute bottom-0 left-0 right-0 z-chrome px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3"
            >
              <div className="pointer-events-auto">
                <DeviceStatusPrompt
                  devices={state.devices}
                  upgradingDevices={upgradingDevices}
                  onUpgradeDevice={onUpgradeDevice}
                  onOpenCloudDeviceSettings={() => navigateTo('/settings')}
                  activeDeviceId={activeDeviceId}
                  requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                  compact
                  className="mb-2"
                />
                <ChatInput
                  value={state.input}
                  onChange={onInputChange}
                  onSubmit={onSend}
                  disabled={composerDisabled}
                  placeholder={t(
                    'workbench.mobile_input_placeholder',
                    '询问 Wework',
                  )}
                  projectChat={projectChat}
                  projectWork={projectWork}
                  queuedMessages={queuedMessages}
                  guidanceMessages={guidanceMessages}
                  isStreaming={isResponseStreaming}
                  onPause={onPauseResponse}
                  onCancelQueuedMessage={onCancelQueuedMessage}
                  onSendQueuedAsGuidance={onSendQueuedAsGuidance}
                  onEditQueuedMessage={onEditQueuedMessage}
                  onCancelGuidanceMessage={onCancelGuidanceMessage}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-dvh min-h-0 flex-col pb-[max(16px,env(safe-area-inset-bottom))]">
            <header
              data-testid="mobile-empty-header"
              className="flex min-h-[56px] shrink-0 items-center gap-2 border-b border-transparent bg-background/95 px-3 pb-2 pt-[max(6px,env(safe-area-inset-top))]"
            >
              <button
                type="button"
                data-testid="open-mobile-drawer-button"
                onClick={() => setDrawerOpen(true)}
                className="flex h-11 min-w-[44px] items-center justify-center rounded-full text-text-primary hover:bg-surface"
                aria-label={t('workbench.open_menu', '打开菜单')}
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="flex min-w-0 flex-1 justify-start">
                {(effectiveProjectChat.isModelSelectionReady ?? true) ? (
                  <ModelSelector
                    models={effectiveProjectChat.models}
                    selectedModel={effectiveProjectChat.selectedModel}
                    selectedModelOptions={effectiveProjectChat.selectedModelOptions}
                    disabled={false}
                    onSelectModel={effectiveProjectChat.setSelectedModel}
                    onSelectModelOption={effectiveProjectChat.setSelectedModelOption}
                    menuPlacement="below"
                    buttonClassName="max-w-[min(14rem,calc(100vw-6rem))] bg-surface px-3"
                    menuClassName="left-0 right-auto w-[min(34rem,calc(100vw-2rem))]"
                  />
                ) : (
                  <div className="h-10 w-32" data-testid="model-selector-loading" />
                )}
              </div>
              <div className="h-11 min-w-[44px]" />
            </header>

            <section className="flex min-h-0 flex-1 items-center justify-center px-5 pb-6">
              <div
                data-testid="mobile-empty-state-content"
                className="flex w-full max-w-[360px] flex-col items-center gap-6"
              >
                <Bot className="h-8 w-8 text-text-muted" />
                <h1 className="text-center text-2xl font-semibold tracking-normal">
                  {emptyTitle}
                </h1>
                <ProjectWorkBar
                  {...effectiveProjectWork}
                  className="min-h-0 flex-col justify-center gap-1 px-0"
                  buttonClassName="bg-surface px-4 text-text-primary"
                  menuClassName="left-1/2 w-[min(20rem,calc(100vw-2.5rem))] -translate-x-1/2"
                  emptyLabel={t('workbench.select_project', '选择项目')}
                />
              </div>
            </section>
            <div
              data-testid="mobile-empty-chat-input-dock"
              className="px-4 pb-0 pt-3"
            >
              <DeviceStatusPrompt
                devices={state.devices}
                upgradingDevices={upgradingDevices}
                onUpgradeDevice={onUpgradeDevice}
                onOpenCloudDeviceSettings={() => navigateTo('/settings')}
                activeDeviceId={activeDeviceId}
                requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                compact
                className="mb-2"
              />
              <ChatInput
                value={state.input}
                onChange={onInputChange}
                onSubmit={onSend}
                disabled={composerDisabled}
                placeholder={t(
                  'workbench.mobile_input_placeholder',
                  '询问 Wework',
                )}
                projectChat={projectChat}
                projectWork={projectWork}
                queuedMessages={queuedMessages}
                guidanceMessages={guidanceMessages}
                isStreaming={isResponseStreaming}
                onPause={onPauseResponse}
                onCancelQueuedMessage={onCancelQueuedMessage}
                onSendQueuedAsGuidance={onSendQueuedAsGuidance}
                onEditQueuedMessage={onEditQueuedMessage}
                onCancelGuidanceMessage={onCancelGuidanceMessage}
              />
            </div>
          </div>
        )}
      </main>

      <MobileDrawer
        open={drawerOpen}
        user={state.user}
        projects={state.projects}
        recentTasks={state.recentTasks}
        runningTaskIds={runningTaskIds}
        currentProjectId={state.currentProject?.id}
        currentTaskId={state.currentTask?.id}
        activeItem={activeItem}
        onClose={() => setDrawerOpen(false)}
        onNewChat={onNewChat}
        onStartStandaloneChat={onStartStandaloneChat}
        onOpenSettings={() => {
          setSettingsOpen(true)
          navigateTo('/settings')
        }}
        onSelectProject={onSelectProject}
        onOpenTask={onOpenTask}
      />
    </div>
  )
}
