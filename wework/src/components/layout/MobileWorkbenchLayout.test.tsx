import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import { WorkbenchContext, WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type {
  WorkbenchContextValue,
  WorkbenchPaneContextValue,
} from '@/features/workbench/workbenchContextTypes'
import type { RuntimeWorkListResponse, UnifiedModel } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { MobileWorkbenchLayout as ActualMobileWorkbenchLayout } from './MobileWorkbenchLayout'
import '@/i18n'

const paneSessionMockRef = vi.hoisted(() => ({
  current: undefined as unknown,
}))

vi.mock('./useWorkbenchPaneSession', () => ({
  useWorkbenchPaneSession: () => paneSessionMockRef.current,
}))

function createPaneStatus({
  messages = [],
  sending = false,
  waitingForAssistant = false,
  taskRunning = false,
}: {
  messages?: WorkbenchMessage[]
  sending?: boolean
  waitingForAssistant?: boolean
  taskRunning?: boolean
} = {}) {
  const activeAssistantMessage =
    [...messages]
      .reverse()
      .find(message => message.role === 'assistant' && message.status === 'streaming') ?? null
  const isSubmitting = Boolean(sending)
  const isAwaitingAssistant = Boolean(waitingForAssistant)
  const isAssistantStreaming = Boolean(activeAssistantMessage)
  const isResponseActive = isAwaitingAssistant || isAssistantStreaming
  const isBusy = isSubmitting || isResponseActive || taskRunning

  return {
    sendPhase: isSubmitting ? 'submitting' : isAwaitingAssistant ? 'awaiting_assistant' : 'idle',
    activeAssistantMessage,
    taskExecution: { known: taskRunning, running: taskRunning, status: null },
    isSubmitting,
    isAwaitingAssistant,
    isAssistantStreaming,
    isResponseActive,
    isBusy,
    isWaitingForAssistantIndicator: isSubmitting || isAwaitingAssistant || taskRunning,
    canSendQueuedMessage: !isBusy,
  }
}

const originalInnerWidth = window.innerWidth

const baseState = {
  user: { id: 1, user_name: 'MI', email: 'mi@example.com' },
  defaultTeam: null,
  projects: [
    {
      id: 1,
      name: 'github_wegent',
      tasks: [
        {
          id: 11,
          task_id: 7,
          task_title: '项目任务',
          task_status: 'COMPLETED',
          created_at: '2026-05-25T00:00:00.000Z',
        },
      ],
    },
  ],
  devices: [],
  runtimeWork: null,
  currentProject: null,
  currentRuntimeTask: null,
  standaloneDeviceId: null,
  input: '',
  isBootstrapping: false,
  isSending: false,
  error: null,
}

const baseProjectChat = {
  models: [{ name: 'kimi-for-coding', type: 'user' as const }],
  skills: [],
  selectedModel: { name: 'kimi-for-coding', type: 'user' as const },
  selectedModelOptions: {},
  selectedSkills: [],
  attachments: [],
  uploadingFiles: new Map(),
  errors: new Map(),
  isOptionsLocked: false,
  setSelectedModel: vi.fn(),
  setSelectedModelOption: vi.fn(),
  toggleSkill: vi.fn(),
  handleFileSelect: vi.fn().mockResolvedValue(undefined),
  removeAttachment: vi.fn().mockResolvedValue(undefined),
}

function createDefaultImNotificationSettings() {
  return {
    global: {
      enabled: false,
      sessionKey: null,
      session: null,
    },
    runtimeTaskSubscriptions: [],
  }
}

type LegacyMobileWorkbenchLayoutProps = {
  state?: Record<string, unknown>
  messages?: WorkbenchMessage[]
  queuedMessages?: unknown[]
  guidanceMessages?: unknown[]
  codeCommentContexts?: unknown[]
  projectChat?: Partial<ProjectChatControls>
  projectWork?: Record<string, unknown>
  onSelectProject?: (projectId: number | null) => void
  onInputChange?: (input: string) => void
  onSend?: () => void | Promise<void>
  onStartStandaloneChat?: () => void
  onOpenRuntimeTask?: (...args: unknown[]) => Promise<void> | void
  onListImPrivateSessions?: () => Promise<unknown>
  onBindRuntimeTaskToImSessions?: (...args: unknown[]) => Promise<unknown>
  onUpdateProjectName?: (...args: unknown[]) => Promise<void> | void
  onRemoveProject?: (...args: unknown[]) => Promise<void> | void
  onCreateProject?: (...args: unknown[]) => Promise<unknown>
  onCreateGitWorkspaceProject?: (...args: unknown[]) => Promise<unknown>
  onPrepareDeviceWorkspace?: (...args: unknown[]) => Promise<unknown>
  onDeleteDeviceWorkspace?: (...args: unknown[]) => Promise<void>
  onListGitRepositories?: () => Promise<unknown[]>
  onListGitBranches?: (...args: unknown[]) => Promise<unknown[]>
  onGetDeviceHomeDirectory?: (...args: unknown[]) => Promise<string>
  onGetProjectWorkspaceRoot?: (...args: unknown[]) => Promise<string>
  onListDeviceDirectories?: (...args: unknown[]) => Promise<string[]>
  onCreateDeviceDirectory?: (...args: unknown[]) => Promise<void>
  onRefreshWorkLists?: () => Promise<void>
  onLoadEnvironmentInfo?: (...args: unknown[]) => Promise<unknown>
  onLoadEnvironmentDiff?: (...args: unknown[]) => Promise<string>
  onCommitEnvironmentChanges?: (...args: unknown[]) => Promise<void>
  onListEnvironmentBranches?: (...args: unknown[]) => Promise<string[]>
  onCheckoutEnvironmentBranch?: (...args: unknown[]) => Promise<void>
  onCreateEnvironmentBranch?: (...args: unknown[]) => Promise<void>
  onUpgradeDevice?: (...args: unknown[]) => Promise<void>
  onRequestUserInputSubmit?: (...args: unknown[]) => Promise<boolean> | void
}

function createPendingRequestUserInputMessage(includeAdjustment = false): WorkbenchMessage {
  return {
    id: 'assistant-request',
    role: 'assistant',
    content: '',
    status: 'streaming',
    createdAt: '2026-06-30T00:00:01.000Z',
    blocks: [
      {
        id: 'request-1',
        type: 'tool',
        toolName: 'request_user_input',
        status: 'pending',
        renderPayload: {
          kind: 'request_user_input',
          request_id: 42,
          questions: [
            {
              id: 'implement',
              question: '执行此计划?',
              options: [{ label: '是的，执行此计划' }],
            },
            ...(includeAdjustment
              ? [
                  {
                    id: 'adjustment',
                    question: '否，请告知 WeWork 如何调整',
                    is_other: true,
                  },
                ]
              : []),
          ],
        },
      },
    ],
  }
}

function MobileWorkbenchLayout(props: LegacyMobileWorkbenchLayoutProps) {
  const { workbenchValue, paneValue, paneSession } = createWorkbenchMocks(props)
  // eslint-disable-next-line react-hooks/immutability -- Vitest hoisted mocks need the latest pane session before rendering the layout.
  paneSessionMockRef.current = paneSession

  return (
    <WorkbenchContext.Provider value={workbenchValue}>
      <WorkbenchPaneContext.Provider value={paneValue}>
        <ActualMobileWorkbenchLayout />
      </WorkbenchPaneContext.Provider>
    </WorkbenchContext.Provider>
  )
}

function createWorkbenchMocks(props: LegacyMobileWorkbenchLayoutProps) {
  const projectWork = props.projectWork ?? {}
  const state = {
    ...baseState,
    selectedDeviceWorkspaceId: null,
    pendingProjectWorkspaceProjectId: null,
    standaloneWorkspacePath: null,
    ...props.state,
    projects: projectWork.projects ?? props.state?.projects ?? baseState.projects,
    devices: projectWork.devices ?? props.state?.devices ?? baseState.devices,
    runtimeWork: projectWork.runtimeWork ?? props.state?.runtimeWork ?? baseState.runtimeWork,
    standaloneDeviceId:
      props.state?.standaloneDeviceId ?? projectWork.currentStandaloneDeviceId ?? null,
    selectedDeviceWorkspaceId:
      props.state?.selectedDeviceWorkspaceId ?? projectWork.selectedDeviceWorkspaceId ?? null,
    pendingProjectWorkspaceProjectId:
      props.state?.pendingProjectWorkspaceProjectId ??
      projectWork.pendingProjectWorkspaceProjectId ??
      null,
  }
  const projectChat = {
    ...baseProjectChat,
    isModelSelectionReady: true,
    isAttachmentReadyToSend: true,
    onBlockedModelSelect: vi.fn(),
    setSelectedSkills: vi.fn(),
    addExistingAttachment: vi.fn(),
    resetAttachments: vi.fn(),
    listLocalSkills: vi.fn().mockResolvedValue([]),
    ...props.projectChat,
  }
  const workbenchValue = {
    state,
    isStartupReady: true,
    workspaceFileApi: {
      listWorkspaceEntries: vi.fn().mockResolvedValue({ path: '/', entries: [] }),
      readWorkspaceTextFile: vi.fn(),
    },
    currentRuntimeTaskRunning: Boolean(state.currentRuntimeTask),
    cloudWorkStatus: {
      availability: 'available',
      checks: { teams: 'available', devices: 'available', runtimeWork: 'available' },
      error: null,
      updatedAt: null,
    },
    projectChat,
    upgradingDevices: {},
    projectExecutionMode: projectWork.executionMode ?? 'current_workspace',
    setProjectExecutionMode: projectWork.onExecutionModeChange ?? vi.fn(),
    projectWorktreeBranch: projectWork.worktreeBranch ?? null,
    setProjectWorktreeBranch: projectWork.onWorktreeBranchChange ?? vi.fn(),
    selectProject: props.onSelectProject ?? projectWork.onSelectProject ?? vi.fn(),
    selectProjectWorkspace: projectWork.onSelectProjectWorkspace ?? vi.fn(),
    selectStandaloneDevice: projectWork.onSelectStandaloneDevice ?? vi.fn(),
    openStandaloneWorkspace: vi.fn().mockResolvedValue(undefined),
    startNewChat: vi.fn(),
    startStandaloneChat: props.onStartStandaloneChat ?? vi.fn(),
    startNewProjectChat: vi.fn(),
    openRuntimeTask: props.onOpenRuntimeTask ?? vi.fn().mockResolvedValue(undefined),
    searchRuntimeWork: vi.fn().mockResolvedValue({ items: [] }),
    loadRuntimeTranscriptForPane: vi.fn().mockResolvedValue({ messages: [] }),
    subscribeRuntimeTaskStream: vi.fn(() => vi.fn()),
    renameRuntimeTask: vi.fn().mockResolvedValue(undefined),
    archiveRuntimeTask: vi.fn().mockResolvedValue(undefined),
    archiveProjectConversations: vi.fn().mockResolvedValue(undefined),
    archiveProjectsConversations: vi.fn().mockResolvedValue(undefined),
    archiveChatConversations: vi.fn().mockResolvedValue(undefined),
    forkCurrentRuntimeTask: vi.fn().mockResolvedValue(undefined),
    listImPrivateSessions:
      props.onListImPrivateSessions ?? vi.fn().mockResolvedValue({ total: 0, items: [] }),
    bindRuntimeTaskToImSessions:
      props.onBindRuntimeTaskToImSessions ??
      vi.fn().mockRejectedValue(new Error('Missing bind handler')),
    getImNotificationSettings: vi.fn().mockResolvedValue(createDefaultImNotificationSettings()),
    updateGlobalImNotification: vi.fn().mockResolvedValue(createDefaultImNotificationSettings()),
    subscribeRuntimeTaskNotifications: vi.fn().mockResolvedValue({ subscribed: true }),
    unsubscribeRuntimeTaskNotifications: vi.fn().mockResolvedValue({ subscribed: false }),
    rememberExecutionDevice: vi.fn(),
    refreshWorkLists: props.onRefreshWorkLists ?? vi.fn().mockResolvedValue(undefined),
    refreshDevices: vi.fn().mockResolvedValue(undefined),
    getRemoteDeviceStartupCommand: vi.fn().mockResolvedValue({ command: '' }),
    upgradeDevice: props.onUpgradeDevice ?? vi.fn().mockResolvedValue(undefined),
    createProject:
      props.onCreateProject ?? vi.fn().mockResolvedValue({ id: 1, name: '', tasks: [] }),
    createGitWorkspaceProject:
      props.onCreateGitWorkspaceProject ??
      vi.fn().mockResolvedValue({ id: 1, name: '', tasks: [] }),
    prepareDeviceWorkspace:
      props.onPrepareDeviceWorkspace ?? vi.fn().mockResolvedValue({ workspaceId: 1 }),
    deleteDeviceWorkspace: props.onDeleteDeviceWorkspace ?? vi.fn().mockResolvedValue(undefined),
    listGitRepositories: props.onListGitRepositories ?? vi.fn().mockResolvedValue([]),
    listGitBranches: props.onListGitBranches ?? vi.fn().mockResolvedValue([]),
    updateProjectName: props.onUpdateProjectName ?? vi.fn().mockResolvedValue(undefined),
    removeProject: props.onRemoveProject ?? vi.fn().mockResolvedValue(undefined),
    getDeviceHomeDirectory:
      props.onGetDeviceHomeDirectory ?? vi.fn().mockResolvedValue('/home/user'),
    getProjectWorkspaceRoot:
      props.onGetProjectWorkspaceRoot ?? vi.fn().mockResolvedValue('/workspace/projects'),
    listDeviceDirectories: props.onListDeviceDirectories ?? vi.fn().mockResolvedValue([]),
    createDeviceDirectory: props.onCreateDeviceDirectory ?? vi.fn().mockResolvedValue(undefined),
    loadEnvironmentInfo: vi.fn().mockResolvedValue({
      additions: '+0',
      deletions: '-0',
      executionTarget: 'local',
    }),
    loadEnvironmentDiff: props.onLoadEnvironmentDiff ?? vi.fn().mockResolvedValue(''),
    commitEnvironmentChanges:
      props.onCommitEnvironmentChanges ?? vi.fn().mockResolvedValue(undefined),
    commitAndPushEnvironmentChanges: vi.fn().mockResolvedValue(undefined),
    pushEnvironmentChanges: vi.fn().mockResolvedValue(undefined),
    listEnvironmentBranches: props.onListEnvironmentBranches ?? vi.fn().mockResolvedValue([]),
    checkoutEnvironmentBranch:
      props.onCheckoutEnvironmentBranch ?? vi.fn().mockResolvedValue(undefined),
    createEnvironmentBranch:
      props.onCreateEnvironmentBranch ?? vi.fn().mockResolvedValue(undefined),
    sendRuntimePaneMessage: vi.fn().mockResolvedValue(true),
    cancelRuntimePaneTask: vi.fn().mockResolvedValue(true),
    sendCurrentInput: props.onSend ?? vi.fn().mockResolvedValue(true),
    retryFailedMessage: vi.fn().mockResolvedValue(true),
    pauseCurrentResponse: vi.fn().mockResolvedValue(undefined),
    loadTurnFileChangesDiff: vi.fn().mockResolvedValue(''),
    revertTurnFileChanges: vi.fn().mockResolvedValue({ changed_files: [] }),
  } as unknown as WorkbenchContextValue
  const paneValue = {
    ...workbenchValue,
    state: {
      isBootstrapping: state.isBootstrapping,
      projects: state.projects,
      devices: state.devices,
      runtimeWork: state.runtimeWork,
      standaloneDeviceId: state.standaloneDeviceId,
      selectedDeviceWorkspaceId: state.selectedDeviceWorkspaceId,
      pendingProjectWorkspaceProjectId: state.pendingProjectWorkspaceProjectId,
      user: state.user,
      error: state.error,
    },
  } as unknown as WorkbenchPaneContextValue
  const paneSession = {
    messages: props.messages ?? [],
    queuedMessages: props.queuedMessages ?? [],
    guidanceMessages: props.guidanceMessages ?? [],
    codeCommentContexts: props.codeCommentContexts ?? [],
    input: String(state.input ?? ''),
    setInput: props.onInputChange ?? vi.fn(),
    sending: Boolean(state.isSending),
    waitingForAssistant: false,
    status: createPaneStatus({
      messages: props.messages ?? [],
      sending: Boolean(state.isSending),
      taskRunning: workbenchValue.currentRuntimeTaskRunning,
    }),
    transcriptLoading: false,
    transcriptHasMoreBefore: false,
    transcriptLoadingMoreBefore: false,
    turnNavigation: [],
    loadMoreTranscriptBefore: vi.fn().mockResolvedValue(undefined),
    loadTranscriptTurnNavigationItem: vi.fn().mockResolvedValue(undefined),
    loadTranscriptGap: vi.fn().mockResolvedValue(undefined),
    send: props.onSend ?? vi.fn().mockResolvedValue(undefined),
    retryFailedMessage: vi.fn().mockResolvedValue(true),
    sendRequestUserInputResponse: props.onRequestUserInputSubmit ?? vi.fn().mockResolvedValue(true),
    ignoreRequestUserInput: vi.fn(),
    answeredRequestUserInputIds: new Set(),
    addCodeComment: vi.fn(),
    clearCodeComments: vi.fn(),
    cancelQueuedMessage: vi.fn(),
    sendQueuedAsGuidance: vi.fn().mockResolvedValue(undefined),
    editQueuedMessage: vi.fn(),
    cancelGuidanceMessage: vi.fn(),
  }

  return { workbenchValue, paneValue, paneSession }
}

function runtimeWork(
  items: Array<{
    id: number
    name: string
    workspaceId?: number | null
    deviceId?: string
    deviceName?: string
    workspacePath?: string
  }>
): RuntimeWorkListResponse {
  return {
    projects: items.map(item => ({
      project: { id: item.id, name: item.name },
      deviceWorkspaces: [
        {
          id: item.workspaceId ?? null,
          projectId: item.id,
          deviceId: item.deviceId ?? 'device-1',
          deviceName: item.deviceName ?? 'Local Device',
          deviceStatus: 'online',
          available: true,
          workspacePath: item.workspacePath ?? `/workspace/${item.name}`,
          mapped: true,
          tasks: [],
        },
      ],
    })),
    chats: [],
    totalTasks: 0,
  }
}

describe('MobileWorkbenchLayout', () => {
  function createDeferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    return { promise, resolve, reject }
  }

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    })
    window.dispatchEvent(new Event('resize'))
  })

  function renderAtMobileWidth(ui: ReactNode) {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 400,
    })
    return render(ui)
  }

  test('uses the project selector instead of a static project work shortcut', async () => {
    const onSelectProject = vi.fn()
    const onSelectProjectWorkspace = vi.fn()

    render(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[]}
        projectWork={{
          projects: baseState.projects,
          devices: [],
          runtimeWork: runtimeWork([
            {
              id: 1,
              name: 'github_wegent',
              workspaceId: 10,
            },
          ]),
          currentProject: null,
          currentProjectId: undefined,
          currentStandaloneDeviceId: null,
          selectedDeviceWorkspaceId: null,
          executionMode: 'current_workspace',
          executionModeLocked: false,
          onSelectProject,
          onSelectProjectWorkspace,
          onSelectStandaloneDevice: vi.fn(),
          onExecutionModeChange: vi.fn(),
        }}
        onSelectProject={onSelectProject}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    expect(screen.queryByText('项目工作')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-work-button')).toHaveTextContent('选择项目')

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('project-option-1'))

    expect(onSelectProjectWorkspace).toHaveBeenCalledWith(1, 10)
    expect(onSelectProject).not.toHaveBeenCalled()
  })

  test('does not show the user avatar on the mobile empty chat page', () => {
    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[]}
        projectChat={baseProjectChat}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    expect(screen.queryByText('MI')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-empty-header')).toHaveClass('bg-background/95')
    expect(screen.getByTestId('open-mobile-drawer-button')).toHaveClass('h-11', 'text-text-primary')
    expect(screen.getByTestId('open-mobile-drawer-button')).not.toHaveClass('bg-surface')
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('kimi-for-coding')
    expect(screen.getByTestId('mobile-empty-chat-input-dock')).toHaveClass('px-4', 'pt-3')
    expect(screen.getByTestId('mobile-empty-chat-input-dock').className).not.toMatch(
      /\bz-(?:modal|critical)\b/
    )
    expect(screen.getByTestId('mobile-empty-state-content')).toHaveClass('items-center', 'gap-6')
    expect(screen.getByTestId('project-work-button').parentElement?.parentElement).toHaveClass(
      'flex-col',
      'gap-1'
    )
    expect(screen.getByTestId('mobile-empty-state-content').parentElement).toHaveClass(
      'items-center',
      'justify-center'
    )
    expect(screen.getByTestId('compact-input-pill')).toHaveClass('min-h-[52px]')
    expect(screen.getByTestId('add-context-button')).toHaveClass('h-[52px]')
  })

  test('treats a selected runtime task with an empty transcript as a conversation', () => {
    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-empty',
          },
        }}
        messages={[]}
        projectChat={baseProjectChat}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    expect(screen.getByTestId('mobile-chat-input-dock')).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-empty-state-content')).not.toBeInTheDocument()
  })

  test('submits implementation plan confirmation as a user message response on mobile', async () => {
    const onRequestUserInputSubmit = vi.fn().mockResolvedValue(true)

    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-plan',
          },
        }}
        messages={[createPendingRequestUserInputMessage()]}
        projectChat={baseProjectChat}
        onRequestUserInputSubmit={onRequestUserInputSubmit}
      />
    )

    await userEvent.click(screen.getByTestId('request-user-input-submit-button'))

    expect(onRequestUserInputSubmit).toHaveBeenCalledWith(
      {
        requestId: 42,
        itemId: undefined,
        answers: {
          implement: { answers: ['是的，执行此计划'] },
        },
      },
      { appendUserMessage: true, forceDefaultCollaborationMode: true }
    )
  })

  test('keeps plan mode when submitting implementation plan adjustments on mobile', async () => {
    const onRequestUserInputSubmit = vi.fn().mockResolvedValue(true)
    const user = userEvent.setup()

    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-plan',
          },
        }}
        messages={[createPendingRequestUserInputMessage(true)]}
        projectChat={baseProjectChat}
        onRequestUserInputSubmit={onRequestUserInputSubmit}
      />
    )

    await user.type(screen.getByTestId('request-user-input-custom-adjustment'), '先缩小范围')
    await user.click(screen.getByTestId('request-user-input-submit-button'))

    expect(onRequestUserInputSubmit).toHaveBeenCalledWith(
      {
        requestId: 42,
        itemId: undefined,
        answers: {
          adjustment: { answers: ['先缩小范围'] },
        },
      },
      { appendUserMessage: true, forceDefaultCollaborationMode: false }
    )
  })

  test('ignores the implementation plan confirmation through the pane session on mobile', async () => {
    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-plan',
          },
        }}
        messages={[createPendingRequestUserInputMessage()]}
        projectChat={baseProjectChat}
      />
    )

    const ignoreRequestUserInput = (
      paneSessionMockRef.current as {
        ignoreRequestUserInput: ReturnType<typeof vi.fn>
      }
    ).ignoreRequestUserInput

    await userEvent.click(screen.getByTestId('request-user-input-ignore-button'))

    expect(ignoreRequestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 42,
      })
    )
  })

  test('shows an offline device notice above mobile conversations', () => {
    const offlineDevice = {
      id: 1,
      device_id: 'offline-device',
      name: 'Offline Device',
      status: 'offline' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
      client_ip: '10.201.3.200',
    }
    const project = {
      id: 1,
      name: 'github_wegent',
      config: {
        execution: {
          targetType: 'cloud' as const,
          deviceId: 'offline-device',
        },
      },
      tasks: [
        {
          id: 11,
          task_id: 7,
          task_title: '项目任务',
          task_status: 'COMPLETED',
          created_at: '2026-05-25T00:00:00.000Z',
        },
      ],
    }

    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          projects: [project],
          devices: [offlineDevice],
          currentProject: project,
          input: 'hello',
        }}
        messages={[
          {
            id: 'message-1',
            role: 'user',
            content: 'hello',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
          },
        ]}
        projectChat={baseProjectChat}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    expect(screen.getByTestId('conversation-device-offline-banner')).toHaveTextContent(
      '10.201.3.200 已离线，恢复在线后可继续对话'
    )
    expect(
      within(screen.getByTestId('mobile-chat-input-dock')).getByTestId(
        'conversation-device-offline-banner'
      )
    ).toBeInTheDocument()
    expect(screen.queryByTestId('composer-disabled-reason')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-message-scroll-area')).not.toHaveClass('pt-28')
    expect(screen.getByTestId('send-message-button')).toBeDisabled()
  })

  test('uses a bottom sheet for the mobile model picker', async () => {
    const gptModel: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
          controls: {
            speed: true,
          },
        },
      },
    }
    const claudeModel: UnifiedModel = {
      name: 'claude-sonnet',
      type: 'user',
      displayName: 'Claude Sonnet',
      config: {
        ui: {
          family: 'claude',
          modelLabel: 'Claude Sonnet',
          sortOrder: 10,
        },
      },
    }
    const setSelectedModel = vi.fn()

    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[]}
        projectChat={{
          ...baseProjectChat,
          models: [claudeModel, gptModel],
          selectedModel: gptModel,
          selectedModelOptions: { reasoning: 'high', speed: 'standard' },
          setSelectedModel,
        }}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    expect(screen.queryByTestId('model-selector-tooltip')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-button')).not.toHaveAttribute('style')
    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-selector-menu')).toHaveAttribute('data-mobile', 'true')
    expect(screen.getByTestId('model-selector-menu')).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByTestId('model-selector-menu')).toHaveAttribute(
      'aria-labelledby',
      'model-selector-mobile-title'
    )
    expect(screen.getByTestId('model-selector-menu')).toHaveClass('h-[82dvh]')
    expect(screen.getByTestId('model-selector-menu').closest('.fixed')).toHaveClass('z-modal')
    expect(screen.getByTestId('model-selector-confirm-button').parentElement).toHaveClass(
      'shrink-0'
    )
    expect(screen.getByTestId('model-selector-confirm-button').parentElement).not.toHaveClass(
      'absolute'
    )
    expect(screen.getByTestId('model-selector-search-input')).toHaveClass('text-base', 'leading-5')
    expect(screen.getByTestId('model-selector-model-list')).toHaveClass(
      'overflow-y-auto',
      'scrollbar-none'
    )
    expect(screen.getByTestId('model-control-reasoning-high')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-reasoning-high')).toHaveClass('h-11', 'min-w-[44px]')
    expect(screen.getByTestId('model-control-speed-fast')).toBeInTheDocument()
    expect(screen.getByTestId('model-family-claude')).toHaveClass('h-11', 'min-w-[44px]')

    await userEvent.click(screen.getByTestId('model-family-claude'))
    await userEvent.click(screen.getByTestId('model-option-claude-sonnet'))

    expect(setSelectedModel).toHaveBeenCalledWith(claudeModel)
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
  })

  test('keeps the mobile close-after-selection behavior for reasoning controls', async () => {
    const gptModel: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
        },
      },
    }

    function Harness() {
      const [selectedModelOptions, setSelectedModelOptions] = useState({
        reasoning: 'high',
      })

      return (
        <MobileWorkbenchLayout
          state={baseState}
          messages={[]}
          projectChat={{
            ...baseProjectChat,
            models: [gptModel],
            selectedModel: gptModel,
            selectedModelOptions,
            setSelectedModelOption: (optionId, value) =>
              setSelectedModelOptions(current => ({
                ...current,
                [optionId]: value,
              })),
          }}
          onSelectProject={vi.fn()}
          onInputChange={vi.fn()}
          onSend={vi.fn()}
        />
      )
    }

    renderAtMobileWidth(<Harness />)

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.click(screen.getByTestId('model-control-reasoning-medium'))

    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('中')
  })

  test('shows the selected project in the mobile empty project selector', () => {
    render(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          currentProject: baseState.projects[0],
        }}
        messages={[]}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('github_wegent')
  })

  test('shows worktree branch selection in the mobile empty project controls', async () => {
    const currentProject = {
      ...baseState.projects[0],
      config: {
        mode: 'workspace',
        device_id: 'device-1',
        workspace: {
          source: 'local_path' as const,
          localPath: '/workspace/github_wegent',
        },
      },
    }
    const onLoadEnvironmentInfo = vi.fn().mockResolvedValue({
      additions: '+0',
      deletions: '-0',
      executionTarget: 'local' as const,
      branchName: 'main',
    })
    const onListEnvironmentBranches = vi.fn().mockResolvedValue(['feature/mobile', 'main'])
    const onCheckoutEnvironmentBranch = vi.fn().mockResolvedValue(undefined)
    const onWorktreeBranchChange = vi.fn()

    const renderLayout = (executionMode: 'current_workspace' | 'git_worktree') => (
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          currentProject,
        }}
        messages={[]}
        projectChat={baseProjectChat}
        projectWork={{
          projects: [currentProject],
          devices: [],
          runtimeWork: runtimeWork([
            {
              id: currentProject.id,
              name: currentProject.name,
              workspaceId: 10,
              workspacePath: '/workspace/github_wegent',
            },
          ]),
          currentProject,
          currentProjectId: currentProject.id,
          currentStandaloneDeviceId: null,
          selectedDeviceWorkspaceId: 10,
          executionMode,
          executionModeLocked: false,
          onSelectProject: vi.fn(),
          onSelectProjectWorkspace: vi.fn(),
          onSelectStandaloneDevice: vi.fn(),
          onExecutionModeChange: vi.fn(),
          worktreeBranch: null,
          onWorktreeBranchChange,
        }}
        onSelectProject={vi.fn()}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        onListEnvironmentBranches={onListEnvironmentBranches}
        onCheckoutEnvironmentBranch={onCheckoutEnvironmentBranch}
        onCreateEnvironmentBranch={vi.fn().mockResolvedValue(undefined)}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )
    const { rerender } = renderAtMobileWidth(renderLayout('current_workspace'))

    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(onLoadEnvironmentInfo).not.toHaveBeenCalled()
    expect(onListEnvironmentBranches).not.toHaveBeenCalled()
    expect(screen.getByTestId('project-branch-button')).toBeInTheDocument()
    expect(screen.queryByTestId('project-worktree-branch-button')).not.toBeInTheDocument()
    const controls = screen.getByTestId('project-work-button').parentElement?.parentElement
    expect(controls).toHaveClass('flex-col')
    expect(screen.getByTestId('execution-mode-button')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-work-button'))
    expect(screen.getByTestId('project-work-menu')).toHaveAttribute('data-mobile', 'true')
    expect(screen.getByTestId('project-work-menu')).toHaveClass('fixed', 'max-h-[45dvh]')
    expect(screen.getByTestId('project-search-input')).not.toHaveFocus()
    await userEvent.click(screen.getByTestId('project-work-mobile-close-button'))

    rerender(renderLayout('git_worktree'))

    await userEvent.click(screen.getByTestId('project-worktree-branch-button'))
    expect(await screen.findByTestId('project-worktree-branch-menu')).toHaveAttribute(
      'data-mobile',
      'true'
    )
    expect(onListEnvironmentBranches).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('project-worktree-branch-menu')).toHaveClass('fixed', 'max-h-[45dvh]')
    expect(screen.getByTestId('project-worktree-branch-search-input')).not.toHaveFocus()
    const options = await screen.findAllByTestId('project-worktree-branch-option')
    await userEvent.click(options[0])

    expect(onWorktreeBranchChange).toHaveBeenCalledWith('feature/mobile')
    expect(onCheckoutEnvironmentBranch).not.toHaveBeenCalled()
  })

  test('keeps the conversation chrome fixed while only messages scroll', () => {
    const state = {
      ...baseState,
      currentRuntimeTask: {
        deviceId: 'device-1',
        taskId: 'runtime-3',
      },
    }

    render(
      <MobileWorkbenchLayout
        state={state}
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '长消息',
            status: 'done',
          },
        ]}
        projectChat={baseProjectChat}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    expect(screen.getByRole('main')).toHaveClass('h-full', 'overflow-hidden')
    expect(screen.getByTestId('chat-message-scroll-area')).toHaveClass(
      'overflow-y-auto',
      'pb-28',
      'pt-16'
    )
    expect(screen.getByTestId('mobile-chat-input-dock')).toHaveClass(
      'absolute',
      'bottom-0',
      'pointer-events-none',
      'z-chrome'
    )
    expect(
      within(screen.getByTestId('mobile-chat-input-dock')).getByTestId('chat-message-input')
    ).toHaveAttribute('placeholder', '要求后续变更')
    expect(screen.getByTestId('mobile-conversation-header')).toHaveClass(
      'absolute',
      'bg-background/95',
      'backdrop-blur',
      'z-chrome'
    )
    expect(screen.getByTestId('mobile-conversation-header')).toHaveClass('gap-2')
    expect(screen.getByTestId('open-mobile-drawer-button').closest('header')).toHaveClass(
      'absolute',
      'pointer-events-none'
    )
    expect(screen.getByTestId('open-mobile-drawer-button')).toHaveClass('pointer-events-auto')
    expect(screen.getByTestId('open-mobile-drawer-button')).not.toHaveClass('bg-surface')
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('kimi-for-coding')
  })

  test('opens continue-in-im dialog from the active runtime task header button', async () => {
    const onListImPrivateSessions = vi.fn().mockResolvedValue({
      total: 1,
      items: [
        {
          session_key: 'session-1',
          channel_type: 'wecom',
          channel_label: 'WeCom',
          channel_id: 101,
          conversation_id: 'conversation-1',
          sender_id: 'sender-1',
          display_name: 'Alice',
          mode: 'chat',
          state: 'idle',
          active_task_id: null,
          last_seen_at: '2026-06-20T00:00:00.000Z',
        },
      ],
    })

    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
          },
        ]}
        projectChat={baseProjectChat}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onListImPrivateSessions={onListImPrivateSessions}
      />
    )

    await userEvent.click(screen.getByTestId('mobile-continue-in-im-button'))

    expect(screen.getByTestId('mobile-continue-in-im-button')).toHaveClass('h-11', 'min-w-[44px]')
    expect(onListImPrivateSessions).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByTestId('continue-im-session-session-1')).toHaveTextContent('Alice')
  })

  test('hides continue-in-im action without a mobile runtime task', () => {
    const onListImPrivateSessions = vi.fn().mockResolvedValue({ total: 0, items: [] })

    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
          },
        ]}
        projectChat={baseProjectChat}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onListImPrivateSessions={onListImPrivateSessions}
      />
    )

    expect(screen.queryByTestId('mobile-continue-in-im-button')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onListImPrivateSessions).not.toHaveBeenCalled()
  })

  test('ignores stale private session responses when reopening the mobile dialog', async () => {
    type PrivateSessionResponse = {
      total: number
      items: Array<{
        session_key: string
        channel_type: string
        channel_label: string
        channel_id: number
        conversation_id: string
        sender_id: string
        display_name: string
        mode: 'chat' | 'task'
        state: 'idle'
        active_task_id: null
        last_seen_at: string
      }>
    }
    const firstRequest = createDeferred<PrivateSessionResponse>()
    const secondRequest = createDeferred<PrivateSessionResponse>()
    const onListImPrivateSessions = vi
      .fn()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise)

    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
          },
        ]}
        projectChat={baseProjectChat}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onListImPrivateSessions={onListImPrivateSessions}
      />
    )

    await userEvent.click(screen.getByTestId('mobile-continue-in-im-button'))
    await userEvent.click(screen.getByTestId('continue-im-cancel-button'))
    await userEvent.click(screen.getByTestId('mobile-continue-in-im-button'))

    secondRequest.resolve({
      total: 1,
      items: [
        {
          session_key: 'session-2',
          channel_type: 'wecom',
          channel_label: 'WeCom',
          channel_id: 102,
          conversation_id: 'conversation-2',
          sender_id: 'sender-2',
          display_name: 'Fresh session',
          mode: 'task',
          state: 'idle',
          active_task_id: null,
          last_seen_at: '2026-06-20T00:00:00.000Z',
        },
      ],
    })

    expect(await screen.findByTestId('continue-im-session-session-2')).toHaveTextContent(
      'Fresh session'
    )

    firstRequest.resolve({
      total: 1,
      items: [
        {
          session_key: 'session-1',
          channel_type: 'wecom',
          channel_label: 'WeCom',
          channel_id: 101,
          conversation_id: 'conversation-1',
          sender_id: 'sender-1',
          display_name: 'Stale session',
          mode: 'chat',
          state: 'idle',
          active_task_id: null,
          last_seen_at: '2026-06-20T00:00:00.000Z',
        },
      ],
    })

    await waitFor(() => expect(screen.queryByText('Stale session')).not.toBeInTheDocument())
    expect(screen.getByText('Fresh session')).toBeInTheDocument()
  })

  test('shows a failure notice when mobile bind handler is missing', async () => {
    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
          },
        ]}
        projectChat={baseProjectChat}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onListImPrivateSessions={vi.fn().mockResolvedValue({
          total: 1,
          items: [
            {
              session_key: 'session-1',
              channel_type: 'wecom',
              channel_label: 'WeCom',
              channel_id: 101,
              conversation_id: 'conversation-1',
              sender_id: 'sender-1',
              display_name: 'Alice',
              mode: 'chat',
              state: 'idle',
              active_task_id: null,
              last_seen_at: '2026-06-20T00:00:00.000Z',
            },
          ],
        })}
      />
    )

    await userEvent.click(screen.getByTestId('mobile-continue-in-im-button'))
    expect(await screen.findByTestId('continue-im-session-session-1')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await userEvent.click(screen.getByTestId('continue-im-submit-button'))

    expect(await screen.findByTestId('transient-notice')).toHaveTextContent('继续到私聊失败')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  test('opens project creation as a mobile bottom sheet from the drawer', async () => {
    render(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          devices: [
            {
              device_id: 'mac',
              name: 'macOS Device',
              status: 'online',
            },
          ],
        }}
        messages={[]}
        onCreateProject={vi.fn().mockResolvedValue(baseState.projects[0])}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/Users/test')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/Users/test/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={vi.fn().mockResolvedValue(undefined)}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))
    await userEvent.click(screen.getByTestId('mobile-new-project-button'))

    expect(screen.queryByTestId('mobile-project-create-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-create-dialog')).toHaveClass(
      'rounded-t-[28px]',
      'max-h-[88dvh]'
    )
    expect(screen.getByTestId('project-create-dialog').parentElement).toHaveClass('items-end')
  })

  test('opens runtime tasks from the mobile project drawer', async () => {
    const onOpenRuntimeTask = vi.fn()

    render(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          runtimeWork: {
            projects: [
              {
                project: { id: 1, name: 'github_wegent' },
                totalTasks: 1,
                deviceWorkspaces: [
                  {
                    id: 91,
                    deviceId: 'local-device',
                    deviceName: 'Local Mac',
                    deviceStatus: 'online',
                    available: true,
                    workspacePath: '/repo/Wegent',
                    label: 'Wegent local',
                    tasks: [
                      {
                        taskId: 'codex-1',
                        workspacePath: '/repo/Wegent',
                        title: 'Fix reconnect',
                        runtime: 'codex',
                      },
                    ],
                  },
                ],
              },
            ],
            chats: [],
            totalTasks: 1,
          },
        }}
        messages={[]}
        onOpenRuntimeTask={onOpenRuntimeTask}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))
    expect(screen.getByTestId('mobile-runtime-chat-section')).toHaveTextContent('对话')
    expect(screen.getByTestId('mobile-runtime-chat-empty')).toHaveTextContent('暂无会话')
    expect(screen.queryByText('未映射工作区')).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('github_wegent'))

    expect(screen.queryByText('Local Mac · Wegent local')).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('Fix reconnect'))

    expect(onOpenRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: '/repo/Wegent',
      taskId: 'codex-1',
    })
  })

  test('shows running status on mobile runtime tasks', async () => {
    render(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          runtimeWork: {
            projects: [
              {
                project: { id: 1, name: 'github_wegent' },
                totalTasks: 1,
                deviceWorkspaces: [
                  {
                    id: 91,
                    deviceId: 'local-device',
                    deviceName: 'Local Mac',
                    deviceStatus: 'online',
                    available: true,
                    workspacePath: '/repo/Wegent',
                    tasks: [
                      {
                        taskId: 'codex-1',
                        workspacePath: '/repo/Wegent',
                        title: 'Fix reconnect',
                        runtime: 'codex',
                        running: true,
                      },
                    ],
                  },
                ],
              },
            ],
            chats: [],
            totalTasks: 1,
          },
        }}
        messages={[]}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))
    await userEvent.click(screen.getByText('github_wegent'))

    const runningStatus = screen.getByTestId('mobile-runtime-task-running-codex-1')
    expect(runningStatus).toHaveAttribute('aria-label', '运行中')
    expect(runningStatus).not.toHaveTextContent('运行中')
    expect(runningStatus.querySelector('svg')).not.toBeNull()
  })

  test('renders chat runtime tasks as conversations in the mobile drawer', async () => {
    const onOpenRuntimeTask = vi.fn()
    const chatPath = '/Users/alice/.wecode/wegent-executor/workspace/chats/2026-06-20/hi-1'

    render(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          runtimeWork: {
            projects: [],
            chats: [
              {
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: chatPath,
                workspaceKind: 'chat',
                tasks: [
                  {
                    taskId: 'chat-1',
                    workspacePath: chatPath,
                    workspaceKind: 'chat',
                    title: 'hi',
                    runtime: 'codex',
                  },
                ],
              },
            ],
            totalTasks: 1,
          },
        }}
        messages={[]}
        onOpenRuntimeTask={onOpenRuntimeTask}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))

    expect(screen.getByTestId('mobile-runtime-chat-section')).toHaveTextContent('对话')
    expect(screen.queryByText(`Local Mac ${chatPath}`)).not.toBeInTheDocument()
    expect(screen.queryByText('未映射工作区')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('mobile-chat-runtime-task-button'))

    expect(onOpenRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: chatPath,
      taskId: 'chat-1',
    })
  })

  test('limits mobile project runtime tasks to five newest rows', async () => {
    render(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          runtimeWork: {
            projects: [
              {
                project: { id: 1, name: 'github_wegent' },
                totalTasks: 6,
                deviceWorkspaces: [
                  {
                    id: 91,
                    deviceId: 'local-device',
                    deviceName: 'Local Mac',
                    deviceStatus: 'online',
                    available: true,
                    workspacePath: '/repo/Wegent',
                    tasks: [
                      {
                        taskId: 'task-oldest',
                        workspacePath: '/repo/Wegent',
                        title: 'Oldest hidden task',
                        runtime: 'codex',
                        updatedAt: '2026-06-20T01:00:00Z',
                      },
                      {
                        taskId: 'task-third',
                        workspacePath: '/repo/Wegent',
                        title: 'Third task',
                        runtime: 'codex',
                        updatedAt: '2026-06-20T04:00:00Z',
                      },
                      {
                        taskId: 'task-newest',
                        workspacePath: '/repo/Wegent',
                        title: 'Newest task',
                        runtime: 'codex',
                        updatedAt: '2026-06-20T06:00:00Z',
                      },
                      {
                        taskId: 'task-fifth',
                        workspacePath: '/repo/Wegent',
                        title: 'Fifth task',
                        runtime: 'codex',
                        updatedAt: '2026-06-20T02:00:00Z',
                      },
                      {
                        taskId: 'task-second',
                        workspacePath: '/repo/Wegent',
                        title: 'Second task',
                        runtime: 'codex',
                        updatedAt: '2026-06-20T05:00:00Z',
                      },
                      {
                        taskId: 'task-fourth',
                        workspacePath: '/repo/Wegent',
                        title: 'Fourth task',
                        runtime: 'codex',
                        updatedAt: '2026-06-20T03:00:00Z',
                      },
                    ],
                  },
                ],
              },
            ],
            chats: [],
            totalTasks: 6,
          },
        }}
        messages={[]}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))
    await userEvent.click(screen.getByText('github_wegent'))

    const collapsedRows = screen.getAllByTestId('mobile-runtime-task-button')
    expect(collapsedRows).toHaveLength(5)
    expect(collapsedRows.map(row => row.textContent)).toEqual([
      expect.stringContaining('Newest task'),
      expect.stringContaining('Second task'),
      expect.stringContaining('Third task'),
      expect.stringContaining('Fourth task'),
      expect.stringContaining('Fifth task'),
    ])
    expect(screen.queryByText('Oldest hidden task')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-project-runtime-tasks-expand-1')).toHaveTextContent(
      '展开显示'
    )

    await userEvent.click(screen.getByTestId('mobile-project-runtime-tasks-expand-1'))

    expect(screen.getAllByTestId('mobile-runtime-task-button')).toHaveLength(6)
    expect(screen.getByText('Fourth task')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-project-runtime-tasks-collapse-1')).toHaveTextContent(
      '折叠显示'
    )

    await userEvent.click(screen.getByTestId('mobile-project-runtime-tasks-collapse-1'))

    expect(screen.getAllByTestId('mobile-runtime-task-button')).toHaveLength(5)
    expect(screen.queryByText('Oldest hidden task')).not.toBeInTheDocument()
  })

  test('expands mobile project runtime tasks by ten and collapses back to five', async () => {
    render(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          runtimeWork: {
            projects: [
              {
                project: { id: 1, name: 'github_wegent' },
                totalTasks: 26,
                deviceWorkspaces: [
                  {
                    id: 91,
                    deviceId: 'local-device',
                    deviceName: 'Local Mac',
                    deviceStatus: 'online',
                    available: true,
                    workspacePath: '/repo/Wegent',
                    tasks: Array.from({ length: 26 }, (_, index) => ({
                      taskId: `task-${index + 1}`,
                      workspacePath: '/repo/Wegent',
                      title: `Task ${index + 1}`,
                      runtime: 'codex',
                      updatedAt: '2026-06-20T06:00:00Z',
                    })),
                  },
                ],
              },
            ],
            chats: [],
            totalTasks: 26,
          },
        }}
        messages={[]}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))
    await userEvent.click(screen.getByText('github_wegent'))

    expect(screen.getAllByTestId('mobile-runtime-task-button')).toHaveLength(5)

    await userEvent.click(screen.getByTestId('mobile-project-runtime-tasks-expand-1'))

    expect(screen.getAllByTestId('mobile-runtime-task-button')).toHaveLength(15)
    expect(screen.getByTestId('mobile-project-runtime-tasks-expand-1')).toHaveTextContent(
      '展开显示'
    )
    expect(screen.queryByTestId('mobile-project-runtime-tasks-collapse-1')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-project-runtime-tasks-expand-1'))

    expect(screen.getAllByTestId('mobile-runtime-task-button')).toHaveLength(25)
    expect(screen.getByTestId('mobile-project-runtime-tasks-expand-1')).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-project-runtime-tasks-collapse-1')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-project-runtime-tasks-expand-1'))

    expect(screen.getAllByTestId('mobile-runtime-task-button')).toHaveLength(26)
    expect(screen.queryByTestId('mobile-project-runtime-tasks-expand-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-project-runtime-tasks-collapse-1')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-project-runtime-tasks-collapse-1'))

    expect(screen.getAllByTestId('mobile-runtime-task-button')).toHaveLength(5)
    expect(screen.getByTestId('mobile-project-runtime-tasks-expand-1')).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-project-runtime-tasks-collapse-1')).not.toBeInTheDocument()
  })

  test('opens project actions on long press without expanding the project', async () => {
    const onSelectProject = vi.fn()
    const onUpdateProjectName = vi.fn().mockResolvedValue(undefined)

    render(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[]}
        onUpdateProjectName={onUpdateProjectName}
        onSelectProject={onSelectProject}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))
    const projectButton = screen.getByTestId('mobile-project-item-button')

    fireEvent.pointerDown(projectButton, {
      pointerType: 'touch',
      clientX: 80,
      clientY: 180,
    })
    await new Promise(resolve => setTimeout(resolve, 550))
    fireEvent.pointerUp(projectButton, { pointerType: 'touch' })

    expect(await screen.findByTestId('mobile-project-actions-menu')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-project-actions-menu')).toHaveClass(
      'w-[240px]',
      'rounded-2xl'
    )
    expect(screen.getByTestId('mobile-rename-project-button')).toHaveTextContent('重命名项目')
    expect(screen.queryByTestId('mobile-archive-project-chats-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-remove-project-button')).toHaveTextContent('移除')
    expect(onSelectProject).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('mobile-rename-project-button'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await userEvent.clear(screen.getByTestId('mobile-inline-project-name-input'))
    await userEvent.type(
      screen.getByTestId('mobile-inline-project-name-input'),
      'renamed-project{enter}'
    )
    expect(onUpdateProjectName).toHaveBeenCalledWith(1, 'renamed-project')
  })

  test('opens a mobile-specific settings page without unreleased plugins navigation', async () => {
    const onOpenPlugins = vi.fn()

    render(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[]}
        onOpenPlugins={onOpenPlugins}
        onSelectProject={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))
    await userEvent.click(screen.getByTestId('mobile-settings-button'))

    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()
    expect(screen.queryByTestId('wework-settings-page')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('mobile-settings-plugins-button'))
    expect(window.location.pathname).toBe('/plugins')
  })
})
