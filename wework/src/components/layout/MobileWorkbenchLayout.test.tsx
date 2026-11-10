import type { ProjectChatControls } from '@/components/chat/ChatInput'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { WorkbenchContext, WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type {
  WorkbenchContextValue,
  WorkbenchPaneContextValue,
} from '@/features/workbench/workbenchContextTypes'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import type { UnifiedModel } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useMemo, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { installGitUiTestContributions } from '../../../dsh/ui-git/test-support'
import { MobileWorkbenchLayout as ActualMobileWorkbenchLayout } from './MobileWorkbenchLayout'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(async (capability: string, params: Record<string, unknown> = {}) => {
    if (capability === 'preferences.get') return {}
    if (capability === 'preferences.update') return params.patch ?? {}
    return {}
  }),
}))

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
    taskExecution: {
      known: taskRunning,
      running: taskRunning,
      continuable: true,
      status: null,
    },
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
  onRetryFailedMessage?: (message: WorkbenchMessage) => Promise<boolean>
  runtimeWorkApi?: WorkbenchServices['runtimeWorkApi']
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
  const lifecycleStore = useMemo(() => {
    const store = new RuntimeTaskLifecycleStore('mobile-workbench-layout-test')
    store.syncRuntimeWork(workbenchValue.state.runtimeWork)
    if (workbenchValue.state.currentRuntimeTask) {
      store.executorStarted(workbenchValue.state.currentRuntimeTask)
    }
    return store
  }, [workbenchValue.state.currentRuntimeTask, workbenchValue.state.runtimeWork])

  return (
    <RuntimeTaskLifecycleProvider store={lifecycleStore}>
      <WorkbenchContext.Provider value={workbenchValue}>
        <WorkbenchPaneContext.Provider value={paneValue}>
          <ActualMobileWorkbenchLayout />
        </WorkbenchPaneContext.Provider>
      </WorkbenchContext.Provider>
    </RuntimeTaskLifecycleProvider>
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
  const lifecycleTaskRunning = Boolean(state.currentRuntimeTask)
  const workbenchValue = {
    state,
    isStartupReady: true,
    workspaceFileApi: {
      listWorkspaceEntries: vi.fn().mockResolvedValue({ path: '/', entries: [] }),
      readWorkspaceTextFile: vi.fn(),
    },
    cloudWorkStatus: {
      availability: 'available',
      checks: { teams: 'available', devices: 'available', runtimeWork: 'available' },
      error: null,
      updatedAt: null,
    },
    services: props.runtimeWorkApi ? { runtimeWorkApi: props.runtimeWorkApi } : undefined,
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
    refreshWorkLists: props.onRefreshWorkLists ?? vi.fn().mockResolvedValue(undefined),
    refreshDevices: vi.fn().mockResolvedValue(undefined),
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
    retryFailedMessage: props.onRetryFailedMessage ?? vi.fn().mockResolvedValue(true),
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
      taskRunning: lifecycleTaskRunning,
    }),
    transcriptLoading: false,
    transcriptHasMoreBefore: false,
    transcriptLoadingMoreBefore: false,
    turnNavigation: [],
    loadMoreTranscriptBefore: vi.fn().mockResolvedValue(undefined),
    loadTranscriptTurnNavigationItem: vi.fn().mockResolvedValue(undefined),
    loadTranscriptGap: vi.fn().mockResolvedValue(undefined),
    send: props.onSend ?? vi.fn().mockResolvedValue(undefined),
    retryFailedMessage: props.onRetryFailedMessage ?? vi.fn().mockResolvedValue(true),
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

describe('MobileWorkbenchLayout', () => {
  beforeEach(async () => {
    await installGitUiTestContributions()
  })

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

  test.each([false, true])(
    'keeps one mobile model selector while unavailable (task: %s)',
    async hasTask => {
      renderAtMobileWidth(
        <MobileWorkbenchLayout
          state={{
            ...baseState,
            currentRuntimeTask: hasTask
              ? { taskId: 'missing-model-task', deviceId: 'device-1', workspaceId: 'workspace-1' }
              : null,
          }}
          messages={[]}
          projectChat={{
            ...baseProjectChat,
            models: [],
            selectedModel: null,
            isModelSelectionReady: false,
          }}
          onSelectProject={vi.fn()}
          onInputChange={vi.fn()}
          onSend={vi.fn()}
        />
      )

      const selector = screen.getByTestId('model-selector-button')
      expect(selector).toBeEnabled()
      expect(selector).not.toHaveTextContent(/^$/)
      expect(screen.queryByTestId('model-selector-loading')).not.toBeInTheDocument()
      await userEvent.click(selector)
      expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    }
  )

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
      {
        requestUserInputResponses: [expect.objectContaining({ requestId: 42 })],
        appendUserMessage: true,
        forceDefaultCollaborationMode: true,
      }
    )
  })

  test('submits every request identity from the mobile combined form', async () => {
    const onRequestUserInputSubmit = vi.fn().mockResolvedValue(true)
    const messages = ['first', 'second'].map(itemId => {
      const message = createPendingRequestUserInputMessage()
      message.id = itemId
      message.blocks![0] = {
        ...message.blocks![0],
        id: itemId,
        type: 'tool',
        toolName: 'request_user_input',
        renderPayload: {
          kind: 'request_user_input',
          delivery: 'async',
          itemId,
          questions: [{ id: 'question_1', question: `${itemId}?`, options: [{ label: itemId }] }],
        },
      }
      return message
    })
    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-group',
          },
        }}
        messages={messages}
        projectChat={baseProjectChat}
        onRequestUserInputSubmit={onRequestUserInputSubmit}
      />
    )
    expect(screen.getByText('first?')).toBeVisible()
    expect(screen.getByText('second?')).toBeVisible()
    await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
    expect(onRequestUserInputSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'first' }),
      expect.objectContaining({
        requestUserInputResponses: [
          expect.objectContaining({
            itemId: 'first',
            answers: { question_1: { answers: ['first'] } },
          }),
          expect.objectContaining({
            itemId: 'second',
            answers: { question_1: { answers: ['second'] } },
          }),
        ],
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

  test('retries a failed message immediately after selecting a replacement model', async () => {
    const currentModel: UnifiedModel = {
      name: 'gpt-current',
      type: 'runtime',
      displayName: 'GPT Current',
      config: { ui: { family: 'gpt', modelLabel: 'GPT Current', sortOrder: 10 } },
    }
    const replacementModel: UnifiedModel = {
      name: 'gpt-replacement',
      type: 'runtime',
      displayName: 'GPT Replacement',
      config: { ui: { family: 'gpt', modelLabel: 'GPT Replacement', sortOrder: 20 } },
    }
    const failedMessage: WorkbenchMessage = {
      id: 'failed-assistant',
      role: 'assistant',
      content: '',
      status: 'failed',
      error: 'model request failed',
      createdAt: '2026-07-24T14:21:25.000+08:00',
    }
    const setSelectedModel = vi.fn()
    const retryFailedMessage = vi.fn().mockResolvedValue(true)

    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[failedMessage]}
        projectChat={{
          ...baseProjectChat,
          models: [currentModel, replacementModel],
          selectedModel: currentModel,
          setSelectedModel,
        }}
        onRetryFailedMessage={retryFailedMessage}
      />
    )

    await userEvent.click(screen.getByTestId('assistant-error-switch-model-retry'))
    await waitFor(() => expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument())
    await userEvent.click(screen.getByTestId('model-option-gpt-replacement'))

    await waitFor(() => expect(retryFailedMessage).toHaveBeenCalledWith(failedMessage))
    expect(setSelectedModel).toHaveBeenCalledWith(replacementModel)
    expect(setSelectedModel.mock.invocationCallOrder[0]).toBeLessThan(
      retryFailedMessage.mock.invocationCallOrder[0]
    )
  })

  test('automatically continues to the only private IM session from the mobile header', async () => {
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
    const onBindRuntimeTaskToImSessions = vi.fn().mockResolvedValue(undefined)

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
        onBindRuntimeTaskToImSessions={onBindRuntimeTaskToImSessions}
      />
    )

    await userEvent.click(screen.getByTestId('mobile-continue-in-im-button'))

    expect(screen.getByTestId('mobile-continue-in-im-button')).toHaveClass('h-11', 'min-w-[44px]')
    expect(onListImPrivateSessions).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(onBindRuntimeTaskToImSessions).toHaveBeenCalledWith(
        {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          taskId: 'runtime-1',
        },
        ['session-1']
      )
    )
    expect(await screen.findByTestId('transient-notice')).toHaveTextContent('已发送到私聊')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
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
    const onBindRuntimeTaskToImSessions = vi.fn().mockResolvedValue(undefined)

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
        onBindRuntimeTaskToImSessions={onBindRuntimeTaskToImSessions}
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

    await waitFor(() =>
      expect(onBindRuntimeTaskToImSessions).toHaveBeenCalledWith(
        {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          taskId: 'runtime-1',
        },
        ['session-2']
      )
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await act(async () => {
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
      await firstRequest.promise
    })

    expect(onBindRuntimeTaskToImSessions).toHaveBeenCalledTimes(1)
    expect(onBindRuntimeTaskToImSessions).not.toHaveBeenCalledWith(expect.anything(), ['session-1'])
  })

  test('keeps the mobile dialog open for manual retry when automatic binding fails', async () => {
    const onBindRuntimeTaskToImSessions = vi
      .fn()
      .mockRejectedValue(new Error('Missing bind handler'))

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
        onBindRuntimeTaskToImSessions={onBindRuntimeTaskToImSessions}
      />
    )

    await userEvent.click(screen.getByTestId('mobile-continue-in-im-button'))
    expect(await screen.findByTestId('transient-notice')).toHaveTextContent('继续到私聊失败')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('continue-im-session-session-1')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(onBindRuntimeTaskToImSessions).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('continue-im-submit-button'))
    await waitFor(() => expect(onBindRuntimeTaskToImSessions).toHaveBeenCalledTimes(2))
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
})
