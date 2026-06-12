import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { ChatInput } from '@/components/chat/ChatInput'
import type {
  ProjectChatControls,
  ProjectWorkControls,
} from '@/components/chat/ChatInput'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import { resolveWorkspaceTarget } from '@/lib/workspace-target'
import {
  findWorkbenchDevice,
  getActiveWorkbenchDeviceId,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import {
  isDeviceBelowWeWorkVersion,
  isWeWorkCompatibleDevice,
} from '@/lib/device-capabilities'
import type {
  DeviceInfo,
  ProjectWithTasks,
  Task,
  TurnFileChangesSummary,
} from '@/types/api'
import type { DeviceUpgradeState } from '@/types/device-events'
import type { EnvironmentInfo } from '@/types/environment'
import type {
  GuidanceWorkbenchMessage,
  QueuedWorkbenchMessage,
  WorkbenchMessage,
} from '@/types/workbench'
import type { CodeCommentContext, WorkspaceTarget } from '@/types/workspace-files'
import { cn } from '@/lib/utils'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { BottomWorkspacePanel } from './workspace-panels/BottomWorkspacePanel'
import { RightWorkspacePanel } from './workspace-panels/RightWorkspacePanel'
import { WorkspacePanelActions } from './workspace-panels/WorkspacePanelActions'
import {
  DesktopTopBar,
  MAC_NATIVE_TOP_BAR_ACTION_INSET,
} from './DesktopTopBar'
import { DeviceStatusPrompt } from './DeviceStatusPrompt'

const DESKTOP_COMPOSER_FRAME_CLASS =
  'mx-auto w-[min(58vw,62rem)] min-w-[32rem] max-w-[calc(100vw-4rem)] -translate-y-12'
const DESKTOP_FLOATING_COMPOSER_CLASS =
  'pointer-events-none absolute bottom-4 left-1/2 z-chrome w-[min(58vw,62rem)] min-w-[32rem] max-w-[calc(100%_-_3rem)] -translate-x-1/2'
const DESKTOP_FLOATING_COMPOSER_BACKDROP_CLASS =
  'pointer-events-none absolute inset-x-0 bottom-0 z-10 h-32 bg-gradient-to-t from-background via-background to-transparent'
const DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS =
  'bottom-36 z-popover bg-background/95 shadow-md'
const DESKTOP_QUEUED_SCROLL_TO_BOTTOM_BUTTON_CLASS =
  'bottom-52 z-popover bg-background/95 shadow-md'

function workspaceTargetKey(target: WorkspaceTarget | null): string {
  return target ? `${target.deviceId}:${target.path}:${target.source}` : ''
}

function messageWorkspaceTargetKey(
  currentTask: Task | null,
  messages: WorkbenchMessage[],
): string {
  if (!currentTask) return ''
  let latestUnscopedKey = ''

  for (const message of [...messages].reverse()) {
    const fileChanges = message.fileChanges
    if (
      fileChanges?.status !== 'active' ||
      !fileChanges.device_id ||
      !fileChanges.workspace_path
    ) {
      continue
    }

    const key = `${message.taskId ?? ''}:${fileChanges.device_id}:${fileChanges.workspace_path}`
    if (message.taskId === currentTask.id) {
      return key
    }
    if (message.taskId == null && !latestUnscopedKey) {
      latestUnscopedKey = key
    }
  }

  return latestUnscopedKey
}

interface DesktopWorkbenchMainProps {
  isBootstrapping: boolean
  currentTask: Task | null
  currentProject: ProjectWithTasks | null
  devices: DeviceInfo[]
  upgradingDevices: Record<string, DeviceUpgradeState>
  messages: WorkbenchMessage[]
  queuedMessages: QueuedWorkbenchMessage[]
  guidanceMessages: GuidanceWorkbenchMessage[]
  projectChat: ProjectChatControls
  projectWork: ProjectWorkControls
  input: string
  isSending: boolean
  environmentInfo: EnvironmentInfo
  onRefreshEnvironmentInfo: () => Promise<void>
  onCommitEnvironmentChanges: (message: string) => Promise<void>
  onListEnvironmentBranches: () => Promise<string[]>
  onCheckoutEnvironmentBranch: (branchName: string) => Promise<void>
  onCreateEnvironmentBranch: (branchName: string) => Promise<void>
  onOpenCloudDeviceSettings: () => void
  onUpgradeDevice: (deviceId: string) => Promise<void>
  onInputChange: (value: string) => void
  onSend: () => void
  isResponseStreaming: boolean
  onPauseResponse: () => void
  onCancelQueuedMessage: (id: string) => void
  onSendQueuedAsGuidance: (id: string) => void
  onEditQueuedMessage: (id: string) => void
  onCancelGuidanceMessage: (id: string) => void
  onLoadFileChangesDiff?: (subtaskId: number) => Promise<string>
  onRevertFileChanges?: (
    subtaskId: number,
  ) => Promise<TurnFileChangesSummary>
  onAddCodeComment?: (context: CodeCommentContext) => void
  topBarLeftActions?: ReactNode
}

export function DesktopWorkbenchMain({
  isBootstrapping,
  currentTask,
  currentProject,
  devices,
  upgradingDevices,
  messages,
  queuedMessages,
  guidanceMessages,
  projectChat,
  projectWork,
  input,
  isSending,
  environmentInfo,
  onRefreshEnvironmentInfo,
  onCommitEnvironmentChanges,
  onListEnvironmentBranches,
  onCheckoutEnvironmentBranch,
  onCreateEnvironmentBranch,
  onOpenCloudDeviceSettings,
  onUpgradeDevice,
  onInputChange,
  onSend,
  isResponseStreaming,
  onPauseResponse,
  onCancelQueuedMessage,
  onSendQueuedAsGuidance,
  onEditQueuedMessage,
  onCancelGuidanceMessage,
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onAddCodeComment = () => {},
  topBarLeftActions,
}: DesktopWorkbenchMainProps) {
  const { t } = useTranslation('common')
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false)
  const [workspaceTarget, setWorkspaceTarget] = useState<WorkspaceTarget | null>(null)
  const [workspaceTargetError, setWorkspaceTargetError] = useState<string | null>(null)
  const workspaceDeviceApi = useMemo(() => {
    const { apiBaseUrl } = getRuntimeConfig()
    return createDeviceApi(createHttpClient({ baseUrl: apiBaseUrl }))
  }, [])
  const messagesRef = useRef(messages)
  const workspaceMessageTargetKey = messageWorkspaceTargetKey(currentTask, messages)
  const hasConversation = messages.length > 0 || currentTask
  const hasQueuedComposerRows = queuedMessages.length > 0 || guidanceMessages.length > 0
  const reserveMacWindowControls = isTauriRuntime()
  const activeDeviceId = getActiveWorkbenchDeviceId({
    currentTask,
    currentProject,
    standaloneDeviceId: projectWork.currentStandaloneDeviceId,
  })
  const activeDevice = findWorkbenchDevice(devices, activeDeviceId)
  const activeDeviceUnavailable =
    Boolean(activeDeviceId) && !isWorkbenchDeviceOnline(activeDevice)
  const activeDeviceVersionUnsupported =
    Boolean(activeDevice && isDeviceBelowWeWorkVersion(activeDevice))
  const noStandaloneCompatibleDevice =
    !currentProject &&
    !activeDeviceId &&
    !devices.some(device => device.status === 'online' && isWeWorkCompatibleDevice(device))
  const composerDisabled =
    isSending ||
    activeDeviceUnavailable ||
    activeDeviceVersionUnsupported ||
    noStandaloneCompatibleDevice
  const emptyTitle = currentProject
    ? t('workbench.project_empty_title', {
        defaultValue: `我们应该在 ${currentProject.name} 中构建什么？`,
        projectName: currentProject.name,
      })
    : t('workbench.empty_title', '我们该做什么？')

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    let cancelled = false
    resolveWorkspaceTarget({
      currentTask,
      currentProject,
      messages: messagesRef.current,
      api: workspaceDeviceApi,
    })
      .then(target => {
        if (!cancelled) {
          setWorkspaceTarget(current =>
            workspaceTargetKey(current) === workspaceTargetKey(target)
              ? current
              : target,
          )
          setWorkspaceTargetError(null)
        }
      })
      .catch(error => {
        if (!cancelled) {
          setWorkspaceTarget(null)
          setWorkspaceTargetError(
            error instanceof Error ? error.message : 'Failed to resolve workspace',
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [currentTask, currentProject, workspaceDeviceApi, workspaceMessageTargetKey])

  return (
    <main className="relative flex min-w-0 flex-1 overflow-hidden">
      <DesktopTopBar
        testId="workbench-topbar"
        rightClassName="gap-2"
        className={cn(
          'absolute inset-x-0 top-0 z-chrome bg-background/95 pr-7 backdrop-blur-xl',
          topBarLeftActions && reserveMacWindowControls
            ? undefined
            : topBarLeftActions
              ? 'pl-2'
              : 'pl-6',
        )}
        style={
          topBarLeftActions && reserveMacWindowControls
            ? { paddingLeft: MAC_NATIVE_TOP_BAR_ACTION_INSET }
            : undefined
        }
        left={topBarLeftActions}
        right={(
          <WorkspacePanelActions
            environmentInfo={environmentInfo}
            onRefreshEnvironmentInfo={onRefreshEnvironmentInfo}
            onCommitEnvironmentChanges={onCommitEnvironmentChanges}
            onListEnvironmentBranches={onListEnvironmentBranches}
            onCheckoutEnvironmentBranch={onCheckoutEnvironmentBranch}
            onCreateEnvironmentBranch={onCreateEnvironmentBranch}
            rightPanelOpen={rightPanelOpen}
            bottomPanelOpen={bottomPanelOpen}
            onToggleRightPanel={() => setRightPanelOpen((open) => !open)}
            onToggleBottomPanel={() => setBottomPanelOpen((open) => !open)}
          />
        )}
      />
      <div
        data-testid="desktop-workbench-content"
        className="relative flex min-w-0 flex-1 flex-col overflow-hidden pt-[52px]"
      >
        {isBootstrapping ? (
          <div
            className="flex flex-1"
            data-testid="desktop-workbench-loading"
          />
        ) : hasConversation ? (
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <ScrollableMessageArea
              messages={messages}
              conversationKey={currentTask?.id ?? null}
              className="h-full"
              scrollTestId="desktop-chat-scroll"
              scrollerClassName={hasQueuedComposerRows ? 'pb-44' : 'pb-32'}
              scrollButtonClassName={
                hasQueuedComposerRows
                  ? DESKTOP_QUEUED_SCROLL_TO_BOTTOM_BUTTON_CLASS
                  : DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS
              }
              devices={devices}
              onLoadFileChangesDiff={onLoadFileChangesDiff}
              onRevertFileChanges={onRevertFileChanges}
            />
            <div
              className={DESKTOP_FLOATING_COMPOSER_BACKDROP_CLASS}
              data-testid="desktop-floating-composer-backdrop"
            />
            <div
              className={DESKTOP_FLOATING_COMPOSER_CLASS}
              data-testid="desktop-floating-composer-layer"
            >
              <div
                className="pointer-events-auto"
                data-testid="desktop-floating-composer-card"
              >
                <DeviceStatusPrompt
                  devices={devices}
                  upgradingDevices={upgradingDevices}
                  onUpgradeDevice={onUpgradeDevice}
                  onOpenCloudDeviceSettings={onOpenCloudDeviceSettings}
                  activeDeviceId={activeDeviceId}
                  requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                  hideAvailableUpdates
                  className="mb-2"
                />
                <ChatInput
                  value={input}
                  onChange={onInputChange}
                  onSubmit={onSend}
                  disabled={composerDisabled}
                  placeholder={t('workbench.input_placeholder', '尽管问')}
                  variant="desktop"
                  projectChat={projectChat}
                  projectWork={projectWork}
                  showProjectWorkBar={false}
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
          <div className="flex flex-1 items-center justify-center px-10">
            <div
              className={DESKTOP_COMPOSER_FRAME_CLASS}
              data-testid="desktop-empty-composer-frame"
            >
              <h1 className="mb-9 text-center text-[28px] font-medium leading-9 tracking-normal">
                {emptyTitle}
              </h1>
              <DeviceStatusPrompt
                devices={devices}
                upgradingDevices={upgradingDevices}
                onUpgradeDevice={onUpgradeDevice}
                onOpenCloudDeviceSettings={onOpenCloudDeviceSettings}
                activeDeviceId={activeDeviceId}
                requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                hideAvailableUpdates
                className="mb-3"
              />
              <ChatInput
                value={input}
                onChange={onInputChange}
                onSubmit={onSend}
                disabled={composerDisabled}
                placeholder={t('workbench.input_placeholder', '尽管问')}
                variant="desktop"
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
        {bottomPanelOpen && (
          <BottomWorkspacePanel
            currentProject={currentProject}
            devices={devices}
            onRequestClose={() => setBottomPanelOpen(false)}
          />
        )}
      </div>
      {rightPanelOpen && (
        <RightWorkspacePanel
          currentProject={currentProject}
          devices={devices}
          workspaceTarget={workspaceTargetError ? null : workspaceTarget}
          onAddCodeComment={onAddCodeComment}
          onRequestClose={() => setRightPanelOpen(false)}
        />
      )}
    </main>
  )
}
