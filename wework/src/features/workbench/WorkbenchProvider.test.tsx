import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createContext, StrictMode, useContext, useState } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { LOCAL_USER } from '@/api/local/localSession'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import { WorkbenchProvider, type WorkbenchServices } from './WorkbenchProvider'
import { useWorkbench } from './useWorkbench'
import { MessageList } from '@/components/chat/MessageList'
import { TaskPlanProgress } from '@/components/chat/composer/TaskPlanProgress'
import { useWorkbenchPaneSession } from '@/components/layout/useWorkbenchPaneSession'
import { buildRuntimeTaskRoute, parseRuntimeTaskRoute } from '@/lib/navigation'
import { runtimeProjectUiId, standaloneRuntimeProjectKey } from '@/lib/runtime-project'
import { findRuntimeTask, readLastProjectId, writeLastProjectId } from './workbenchRuntimeHelpers'
import { useRuntimeTaskRouteRestoration } from './useRuntimeTaskRouteRestoration'
import { modelSelectionFromRuntimeHandle } from './runtimeContextUsage'
import { writeCachedRemoteRuntimeWork } from './remoteRuntimeWorkCache'
import { createResponseApiStreamState, emitResponseApiEvent } from '@/stream/responseApiStream'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import {
  CachedWorkbenchPaneStack,
  WorkbenchPaneActiveOnly,
  type WorkbenchPaneIdentity,
} from '@/components/layout/workbenchPaneStack'
import type {
  Attachment,
  DeviceInfo,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeTaskCreateResponse,
  RuntimeGoal,
  RuntimeGuidanceResponse,
  RuntimeTranscriptResponse,
  RuntimeTranscriptRequest,
  TurnFileChangesSummary,
  RuntimeWorkListResponse,
  UnifiedModel,
  User,
} from '@/types/api'

const localExecutorMocks = vi.hoisted(() => ({
  connectLocalExecutorToBackend: vi.fn().mockResolvedValue({ running: true, ready: true }),
  disconnectLocalExecutorFromBackend: vi.fn().mockResolvedValue({ running: true, ready: true }),
  ensureLocalExecutorStarted: vi.fn(),
  requestLocalExecutor: vi.fn(),
  subscribeLocalExecutorEvents: vi.fn(),
}))

vi.mock('@/tauri/localExecutor', () => ({
  connectLocalExecutorToBackend: localExecutorMocks.connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend: localExecutorMocks.disconnectLocalExecutorFromBackend,
  ensureLocalExecutorStarted: localExecutorMocks.ensureLocalExecutorStarted,
  requestLocalExecutor: localExecutorMocks.requestLocalExecutor,
  subscribeLocalExecutorEvents: localExecutorMocks.subscribeLocalExecutorEvents,
}))

function setTauriRuntime() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {},
    configurable: true,
  })
}

function clearTauriRuntime() {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'Project Device',
    status: 'online',
    is_default: true,
    device_type: 'cloud',
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
    ...overrides,
  }
}

function createProject(overrides: Partial<ProjectWithTasks> = {}): ProjectWithTasks {
  return {
    id: 7,
    name: 'Wegent',
    tasks: [],
    config: {
      mode: 'workspace',
      execution: {
        targetType: 'local',
        deviceId: 'device-1',
      },
      workspace: {
        source: 'local_path',
        localPath: '/workspace/project-alpha',
      },
    },
    ...overrides,
  }
}

function createRuntimeGoal(overrides: Partial<RuntimeGoal> = {}): RuntimeGoal {
  return {
    threadId: 'thread-1',
    objective: '现有目标',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1780000000000,
    updatedAt: 1780000000000,
    ...overrides,
  }
}

function createRuntimeWork(
  overrides: Partial<RuntimeWorkListResponse> = {}
): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { id: 7, name: 'Wegent' },
        deviceWorkspaces: [
          {
            id: 22,
            projectId: 7,
            deviceId: 'device-1',
            deviceName: 'Project Device',
            deviceStatus: 'online',
            workspacePath: '/workspace/project-alpha',
            mapped: true,
            available: true,
            tasks: [
              {
                taskId: 'runtime-a',
                workspacePath: '/workspace/project-alpha',
                title: 'Runtime A',
                runtime: 'claude_code',
              },
              {
                taskId: 'runtime-b',
                workspacePath: '/workspace/project-alpha',
                title: 'Runtime B',
                runtime: 'claude_code',
              },
              {
                taskId: 'runtime-restored',
                workspacePath: '/workspace/project-alpha',
                title: 'Restored runtime',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 3,
      },
    ],
    chats: [],
    totalTasks: 3,
    ...overrides,
  }
}

function createTurnFileChanges(): TurnFileChangesSummary {
  return {
    version: 1,
    status: 'active',
    artifact_id: 'artifact-1',
    device_id: 'device-1',
    workspace_path: '/workspace/project-alpha',
    file_count: 1,
    additions: 6,
    deletions: 4,
    files: [
      {
        old_path: null,
        path: 'wework/src/features/workbench/WorkbenchProvider.tsx',
        change_type: 'modified',
        additions: 6,
        deletions: 4,
        binary: false,
      },
    ],
    reverted_at: null,
  }
}

const LOCAL_IMAGE_ATTACHMENT_PATH =
  '/Users/me/.wegent-executor/workspace/attachments/draft/-45/photo.png'

function createImageAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 45,
    filename: 'photo.png',
    file_size: 1200,
    mime_type: 'image/png',
    status: 'ready',
    file_extension: '.png',
    created_at: '2026-05-27T00:00:00.000Z',
    ...overrides,
  }
}

function createLocalImageAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return createImageAttachment({
    id: -45,
    local_path: LOCAL_IMAGE_ATTACHMENT_PATH,
    local_preview_url: LOCAL_IMAGE_ATTACHMENT_PATH,
    ...overrides,
  })
}

function createRuntimeWorkApiMock(overrides: Record<string, unknown> = {}) {
  return {
    listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork()),
    upsertDeviceWorkspace: vi.fn(),
    prepareDeviceWorkspace: vi.fn(),
    getRuntimeTranscript: vi.fn(async (address: RuntimeTaskAddress) => ({
      taskId: address.taskId,
      workspacePath: '/workspace/project-alpha',
      runtime: 'claude_code',
      messages: [],
    })),
    sendRuntimeMessage: vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    }),
    interruptAndSendRuntimeMessage: vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    }),
    compactRuntimeTask: vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    }),
    editLastUserMessage: vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    }),
    guideRuntimeTask: vi.fn().mockResolvedValue({
      accepted: true,
      success: true,
      taskId: 'runtime-a',
      guidanceId: 'guide-1',
    }),
    openRuntimeWorkspace: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      workspacePath: '/workspace/direct-codex',
      runtime: 'codex',
    }),
    renameRuntimeWorkspace: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
    }),
    removeRuntimeWorkspace: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
    }),
    syncRuntimeRemoteProjects: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
    }),
    activateRuntimeProject: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
    }),
    deleteWorktree: vi.fn().mockResolvedValue({ success: true }),
    bindRuntimeTaskImSessions: vi.fn(),
    getImNotificationSettings: vi.fn().mockResolvedValue({
      global: { enabled: false, sessionKey: null, session: null },
      runtimeTaskSubscriptions: [],
    }),
    updateGlobalImNotification: vi.fn(),
    subscribeRuntimeTaskNotifications: vi.fn(),
    unsubscribeRuntimeTaskNotifications: vi.fn(),
    archiveRuntimeTask: vi.fn(),
    archiveConversation: vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
    }),
    archiveProjectConversations: vi.fn().mockResolvedValue({
      accepted: true,
      requestedCount: 1,
      acceptedCount: 1,
      results: [],
    }),
    archiveAllConversations: vi.fn().mockResolvedValue({
      accepted: true,
      requestedCount: 1,
      acceptedCount: 1,
      results: [],
    }),
    cancelRuntimeTask: vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    }),
    revertRuntimeFileChanges: vi.fn().mockResolvedValue({
      fileChanges: {
        ...createTurnFileChanges(),
        status: 'reverted',
        reverted_at: '2026-06-05T00:00:00.000Z',
      },
    }),
    createRuntimeTask: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      taskId: 'runtime-created',
      workspacePath: '/workspace/project-alpha',
      runtime: 'claude_code',
    }),
    getRuntimeGoal: vi.fn().mockResolvedValue({
      accepted: true,
      goal: null,
    }),
    setRuntimeGoal: vi.fn().mockImplementation(request =>
      Promise.resolve({
        accepted: true,
        goal: createRuntimeGoal({
          objective: request.objective ?? '现有目标',
          status: request.status ?? 'active',
        }),
      })
    ),
    clearRuntimeGoal: vi.fn().mockResolvedValue({
      accepted: true,
      goal: null,
    }),
    forkRuntimeTask: vi.fn(),
    ...overrides,
  }
}

function createWorkbenchServices(overrides: Partial<WorkbenchServices> = {}): WorkbenchServices {
  const base = {
    teamApi: {
      getDefaultWorkbenchTeam: vi.fn().mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
    },
    modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
    skillApi: {
      listSkills: vi.fn().mockResolvedValue([]),
      getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
    },
    projectApi: {
      listProjects: vi.fn().mockResolvedValue({ items: [createProject()] }),
      getProject: vi.fn(),
      createProject: vi.fn(),
      updateProject: vi.fn(),
      deleteProject: vi.fn(),
    },
    taskApi: {
      getTurnFileChangesDiff: vi.fn(),
      revertTurnFileChanges: vi.fn(),
    },
    deviceApi: {
      listDevices: vi.fn().mockResolvedValue([createDevice()]),
      getHomeDirectory: vi.fn(),
      getProjectWorkspaceRoot: vi.fn(),
      listDirectories: vi.fn(),
      createDirectory: vi.fn(),
      executeCommand: vi.fn(),
      upgradeDevice: vi.fn(),
      listSkills: vi.fn().mockResolvedValue([]),
    },
    runtimeWorkApi: createRuntimeWorkApiMock(),
    chatStream: {
      subscribe: vi.fn(() => vi.fn()),
    },
  } as unknown as WorkbenchServices

  return {
    ...base,
    ...overrides,
    projectApi: { ...base.projectApi, ...overrides.projectApi },
    taskApi: { ...base.taskApi, ...overrides.taskApi },
    deviceApi: { ...base.deviceApi, ...overrides.deviceApi },
    chatStream: { ...base.chatStream, ...overrides.chatStream },
  } as WorkbenchServices
}

function renderWorkbench(children: React.ReactNode, services = createWorkbenchServices()) {
  return render(
    <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
      <WorkbenchProbeSessionProvider>{children}</WorkbenchProbeSessionProvider>
    </WorkbenchProvider>
  )
}

function renderWorkbenchForUser(
  children: React.ReactNode,
  user: User,
  services = createWorkbenchServices()
) {
  return render(
    <WorkbenchProvider user={user} services={services}>
      <WorkbenchProbeSessionProvider>{children}</WorkbenchProbeSessionProvider>
    </WorkbenchProvider>
  )
}

function renderStrictWorkbench(children: React.ReactNode, services = createWorkbenchServices()) {
  return render(
    <StrictMode>
      <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
        {children}
      </WorkbenchProvider>
    </StrictMode>
  )
}

function renderWorkbenchWithDefaultServices(children: React.ReactNode) {
  const cloudConnectionValue: CloudConnectionContextValue = {
    ...DISCONNECTED_STATE,
    isConnected: false,
    serviceKey: 'test-disconnected',
    connectWithAuthorization: vi.fn(),
    refreshUser: vi.fn(),
    disconnect: vi.fn(),
  }

  return render(
    <CloudConnectionContext.Provider value={cloudConnectionValue}>
      <WorkbenchProvider user={LOCAL_USER}>
        <WorkbenchProbeSessionProvider>{children}</WorkbenchProbeSessionProvider>
      </WorkbenchProvider>
    </CloudConnectionContext.Provider>
  )
}

function hasRuntimeStreamHandler(handlers: ChatStreamHandlers): boolean {
  return Boolean(
    handlers.onChatStart ||
    handlers.onChatChunk ||
    handlers.onChatDone ||
    handlers.onChatError ||
    handlers.onBlockCreated ||
    handlers.onBlockUpdated
  )
}

type WorkbenchProbeSessionValue = {
  workbench: ReturnType<typeof useWorkbench>
  paneSession: ReturnType<typeof useWorkbenchPaneSession>
  currentRuntimeTask: RuntimeTaskAddress | null
}

const WorkbenchProbeSessionContext = createContext<WorkbenchProbeSessionValue | null>(null)

function WorkbenchProbeSessionProvider({ children }: { children: React.ReactNode }) {
  const workbench = useWorkbench()
  const { state: workbenchState } = workbench
  const routeRuntimeTask = useRuntimeTaskRouteRestoration()
  const currentRuntimeTask = workbenchState.currentRuntimeTask ?? routeRuntimeTask

  const paneSession = useWorkbenchPaneSession({
    currentRuntimeTask,
  })

  return (
    <WorkbenchProbeSessionContext.Provider value={{ workbench, paneSession, currentRuntimeTask }}>
      {children}
    </WorkbenchProbeSessionContext.Provider>
  )
}

function useWorkbenchProbeSession() {
  const value = useContext(WorkbenchProbeSessionContext)
  if (!value) {
    throw new Error('useWorkbenchProbeSession must be used within WorkbenchProbeSessionProvider')
  }
  return value
}

function BootstrapProbe() {
  const workbench = useWorkbench()
  return (
    <div>
      <span data-testid="boot-state">
        {workbench.state.isBootstrapping ? 'loading' : workbench.state.user?.user_name}
      </span>
      <span data-testid="startup-ready">{workbench.isStartupReady ? 'ready' : 'loading'}</span>
      <span data-testid="project-count">{workbench.state.projects.length}</span>
      <span data-testid="runtime-total">{workbench.state.runtimeWork?.totalTasks ?? 0}</span>
    </div>
  )
}

function CloudWorkStatusProbe() {
  const { cloudWorkStatus } = useWorkbench()
  return (
    <div>
      <span data-testid="cloud-work-availability">{cloudWorkStatus.availability}</span>
      <span data-testid="cloud-work-devices-check">{cloudWorkStatus.checks.devices}</span>
      <span data-testid="cloud-work-error">{cloudWorkStatus.error ?? ''}</span>
    </div>
  )
}

function DeviceStatusProbe() {
  const workbench = useWorkbench()
  return <span data-testid="device-status">{workbench.state.devices[0]?.status ?? 'missing'}</span>
}

function RemoteRuntimeCacheProbe() {
  const runtimeWork = useWorkbench().state.runtimeWork
  const workspaces = runtimeWork?.projects.flatMap(project => project.deviceWorkspaces) ?? []
  return (
    <div>
      <span data-testid="cached-runtime-project-names">
        {runtimeWork?.projects.map(project => project.project.name).join('|') ?? ''}
      </span>
      <span data-testid="cached-runtime-task-titles">
        {workspaces.flatMap(workspace => workspace.tasks.map(task => task.title)).join('|')}
      </span>
      <span data-testid="cached-runtime-workspace-availability">
        {workspaces.map(workspace => String(workspace.available)).join('|')}
      </span>
      <span data-testid="cached-runtime-device-names">
        {workspaces.map(workspace => workspace.deviceName).join('|')}
      </span>
    </div>
  )
}

function ProjectSendProbe() {
  const { workbench, paneSession, currentRuntimeTask } = useWorkbenchProbeSession()
  const imageAttachment = createImageAttachment()
  const localImageAttachment = createLocalImageAttachment()
  const currentRuntimeTaskSummary = findRuntimeTask(workbench.state.runtimeWork, currentRuntimeTask)
  const currentModelSelection =
    currentRuntimeTaskSummary?.modelSelection ??
    modelSelectionFromRuntimeHandle(currentRuntimeTask?.runtimeHandle)

  return (
    <div>
      <span data-testid="current-runtime-task-address">
        {currentRuntimeTask
          ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.taskId}`
          : 'none'}
      </span>
      <span data-testid="current-project-name">
        {workbench.state.currentProject?.name ?? 'none'}
      </span>
      <span data-testid="standalone-workspace-path">
        {workbench.state.standaloneWorkspacePath ?? 'none'}
      </span>
      <span data-testid="standalone-device-id">{workbench.state.standaloneDeviceId ?? 'none'}</span>
      <span data-testid="current-project-device-id">
        {workbench.state.currentProject?.config?.execution?.deviceId ??
          workbench.state.currentProject?.config?.device_id ??
          'none'}
      </span>
      <span data-testid="standalone-chat-key">{workbench.state.standaloneChatKey}</span>
      <span data-testid="composer-input">{paneSession.input}</span>
      <span data-testid="message-contents">
        {paneSession.messages.map(message => message.content).join('|')}
      </span>
      <span data-testid="message-roles">
        {paneSession.messages.map(message => `${message.role}:${message.content}`).join('|')}
      </span>
      <span data-testid="message-goal-flags">
        {paneSession.messages
          .filter(message => message.runtimeGoalRequest === true)
          .map(message => `goal:${message.content}`)
          .join('|') || 'none'}
      </span>
      <span data-testid="goal-objective">{paneSession.goal?.objective ?? 'none'}</span>
      <span data-testid="goal-draft-active">
        {paneSession.goalDraftActive ? 'active' : 'inactive'}
      </span>
      <span data-testid="project-collaboration-mode">
        {workbench.projectChat.selectedModelOptions.collaborationMode ?? 'default'}
      </span>
      <span data-testid="runtime-context-window">
        {workbench.projectChat.contextUsage?.modelContextWindow ?? 'none'}
      </span>
      <span data-testid="runtime-task-model-selection">
        {currentModelSelection
          ? [
              currentModelSelection.modelName,
              currentModelSelection.modelType ?? '',
              currentModelSelection.options?.collaborationMode ?? '',
            ].join(':')
          : 'none'}
      </span>
      <span data-testid="runtime-project-order">
        {workbench.state.runtimeWork?.projects
          .map(projectWork => projectWork.project.name)
          .join('|') ?? ''}
      </span>
      <span data-testid="runtime-task-titles">
        {workbench.state.runtimeWork?.projects
          .flatMap(projectWork =>
            projectWork.deviceWorkspaces.flatMap(workspace =>
              workspace.tasks.map(task => task.title)
            )
          )
          .join('|') ?? ''}
      </span>
      <span data-testid="runtime-task-statuses">
        {workbench.state.runtimeWork?.projects
          .flatMap(projectWork =>
            projectWork.deviceWorkspaces.flatMap(workspace =>
              workspace.tasks.map(task => task.status ?? 'none')
            )
          )
          .join('|') ?? ''}
      </span>
      <span data-testid="runtime-task-errors">
        {workbench.state.runtimeWork?.projects
          .flatMap(projectWork =>
            projectWork.deviceWorkspaces.flatMap(workspace =>
              workspace.tasks.map(task => task.error ?? '')
            )
          )
          .join('|') ?? ''}
      </span>
      <span data-testid="project-attachment-count">{workbench.projectChat.attachments.length}</span>
      <span data-testid="workbench-error">{workbench.state.error ?? ''}</span>
      <span data-testid="pane-session-error">{paneSession.error ?? ''}</span>
      <span data-testid="sending-state">{paneSession.sending ? 'sending' : 'idle'}</span>
      <span data-testid="pane-busy">{paneSession.status.isBusy ? 'busy' : 'idle'}</span>
      <span data-testid="pane-waiting">
        {paneSession.status.isWaitingForAssistantIndicator ? 'waiting' : 'idle'}
      </span>
      <button type="button" onClick={() => workbench.selectProjectWorkspace(7, null)}>
        select project
      </button>
      <button type="button" onClick={() => workbench.startNewChat()}>
        start new chat
      </button>
      <button type="button" onClick={() => workbench.startStandaloneChat()}>
        start standalone chat
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-a',
          })
        }
      >
        open project runtime task
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openStandaloneWorkspace('device-1', '/workspace/direct-codex')
        }
      >
        open standalone workspace
      </button>
      <button
        type="button"
        onClick={() => {
          const deviceId = workbench.state.standaloneDeviceId
          const workspacePath = workbench.state.standaloneWorkspacePath
          if (!deviceId || !workspacePath) return
          void workbench.removeProject(
            runtimeProjectUiId({
              key: standaloneRuntimeProjectKey(workspacePath),
              stateDeviceId: deviceId,
              name: workspacePath,
            })
          )
        }}
      >
        remove standalone workspace
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openStandaloneWorkspace(
            'device-1',
            '/workspace/direct-codex',
            'Direct Codex'
          )
        }
      >
        open labeled standalone workspace
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openStandaloneWorkspace(
            'local-device',
            '/workspace/cli-codex',
            'CLI Project'
          )
        }
      >
        open cli local-device workspace
      </button>
      <button type="button" onClick={() => paneSession.setInput('修复 CI')}>
        set input
      </button>
      <button type="button" onClick={() => void paneSession.setCurrentGoal()}>
        set goal
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.setSelectedModelOption('collaborationMode', 'plan')}
      >
        enable plan mode
      </button>
      <button
        type="button"
        onClick={() => {
          workbench.projectChat.setSelectedModelOption('collaborationMode', 'plan')
          void paneSession.send()
        }}
      >
        enable plan and send
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.addExistingAttachment(imageAttachment)}
      >
        add image attachment
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.addExistingAttachment(localImageAttachment)}
      >
        add local image attachment
      </button>
      <button type="button" onClick={() => void paneSession.send()}>
        send
      </button>
      <button
        type="button"
        onClick={() => {
          const address = {
            deviceId: 'device-1',
            taskId: 'runtime-b',
            workspacePath: '/workspace/project-alpha',
          }
          window.history.pushState({}, '', buildRuntimeTaskRoute(address))
          void workbench.openRuntimeTask(address)
        }}
      >
        open runtime b
      </button>
      <MessageList
        messages={paneSession.messages}
        isWaitingForAssistant={paneSession.status.isWaitingForAssistantIndicator}
        onRetryFailedMessage={message => void paneSession.retryFailedMessage(message)}
      />
    </div>
  )
}

function RuntimePaneSendProbe() {
  const workbench = useWorkbench()
  const runtimeTasks = [
    ...(workbench.state.runtimeWork?.projects.flatMap(project =>
      project.deviceWorkspaces.flatMap(workspace => workspace.tasks)
    ) ?? []),
    ...(workbench.state.runtimeWork?.chats.flatMap(workspace => workspace.tasks) ?? []),
  ]

  return (
    <div>
      <span data-testid="current-runtime-task-address">
        {workbench.state.currentRuntimeTask
          ? [
              workbench.state.currentRuntimeTask.deviceId,
              workbench.state.currentRuntimeTask.taskId,
              workbench.state.currentRuntimeTask.workspacePath ?? '',
            ].join(':')
          : 'none'}
      </span>
      <span data-testid="runtime-local-task-count">{runtimeTasks.length}</span>
      <span data-testid="runtime-project-count">
        {workbench.state.runtimeWork?.projects.length ?? 0}
      </span>
      <span data-testid="runtime-local-task-titles">
        {runtimeTasks.map(task => task.title).join('|')}
      </span>
      <CachedWorkbenchPaneStack
        activePane={{
          currentRuntimeTask: workbench.state.currentRuntimeTask,
          currentProject: workbench.state.currentProject,
          standaloneChatKey: workbench.state.standaloneChatKey,
        }}
        maxPanes={10}
        renderPane={pane => <RuntimePaneStackItem pane={pane} />}
      />
    </div>
  )
}

function RuntimePaneStackItem({ pane }: { pane: WorkbenchPaneIdentity }) {
  const workbench = useWorkbench()
  const paneSession = useWorkbenchPaneSession({
    currentRuntimeTask: pane.currentRuntimeTask,
  })

  return (
    <WorkbenchPaneActiveOnly>
      <span data-testid="active-pane-key">
        {pane.currentRuntimeTask
          ? [
              pane.currentRuntimeTask.deviceId,
              pane.currentRuntimeTask.taskId,
              pane.currentRuntimeTask.workspacePath ?? '',
            ].join(':')
          : pane.currentProject
            ? `project:${pane.currentProject.id}`
            : 'standalone'}
      </span>
      <span data-testid="pane-message-roles">
        {paneSession.messages.map(message => `${message.role}:${message.content}`).join('|')}
      </span>
      <span data-testid="pane-goal-objective">{paneSession.goal?.objective ?? 'none'}</span>
      <span data-testid="pane-goal-draft-active">
        {paneSession.goalDraftActive ? 'active' : 'inactive'}
      </span>
      <button type="button" onClick={() => workbench.selectProjectWorkspace(7, 22)}>
        select mapped project workspace
      </button>
      <button type="button" onClick={() => workbench.startNewProjectChat(7)}>
        start new project task
      </button>
      <button type="button" onClick={() => void paneSession.setCurrentGoal()}>
        set pane goal
      </button>
      <button type="button" onClick={() => paneSession.setInput('修复 CI')}>
        set pane input
      </button>
      <button type="button" onClick={() => void paneSession.send()}>
        send pane input
      </button>
      <MessageList
        messages={paneSession.messages}
        isWaitingForAssistant={paneSession.status.isWaitingForAssistantIndicator}
      />
    </WorkbenchPaneActiveOnly>
  )
}

function RuntimePaneSessionIdentityProbe() {
  const [address, setAddress] = useState<RuntimeTaskAddress>({
    deviceId: 'device-1',
    workspacePath: '/workspace/project-alpha',
    taskId: 'runtime-a',
  })
  const paneSession = useWorkbenchPaneSession({ currentRuntimeTask: address })

  return (
    <div>
      <span data-testid="runtime-session-messages">
        {paneSession.messages.map(message => message.content).join('|')}
      </span>
      <button
        type="button"
        onClick={() =>
          setAddress({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-a',
          })
        }
      >
        rebuild same runtime address
      </button>
    </div>
  )
}

function RuntimePlanScopeProbe() {
  const { workbench, paneSession } = useWorkbenchProbeSession()
  const runtimeTask = {
    deviceId: 'device-1',
    workspacePath: '/workspace/project-alpha',
    taskId: 'runtime-plan-scope',
  }

  return (
    <div>
      <span data-testid="runtime-plan-scope-task">
        {workbench.state.currentRuntimeTask?.taskId ?? 'none'}
      </span>
      <TaskPlanProgress plan={paneSession.taskPlan} />
      <button type="button" onClick={() => void workbench.openRuntimeTask(runtimeTask)}>
        open runtime plan scope
      </button>
      <button type="button" onClick={workbench.startNewChat}>
        start new plan scope chat
      </button>
    </div>
  )
}

function RuntimeProjectMutationProbe() {
  const workbench = useWorkbench()
  return (
    <div>
      <span data-testid="mutation-project-name">
        {workbench.state.currentProject?.name ?? 'none'}
      </span>
      <span data-testid="mutation-project-order">
        {workbench.state.runtimeWork?.projects
          .map(projectWork => projectWork.project.name)
          .join('|') ?? ''}
      </span>
      <button
        type="button"
        onClick={() =>
          void workbench
            .createProject(
              {
                name: 'New Runtime Project',
                description: '',
                config: { mode: 'workspace' },
              },
              { refreshWorkLists: false }
            )
            .then(project =>
              workbench.prepareDeviceWorkspace(
                {
                  projectId: project.id,
                  deviceId: 'device-1',
                  workspacePath: '/workspace/new-runtime-project',
                  action: 'select',
                },
                { refreshWorkLists: false }
              )
            )
        }
      >
        create runtime project
      </button>
      <button type="button" onClick={() => void workbench.updateProjectName(7, 'Hello project')}>
        rename runtime project
      </button>
      <button type="button" onClick={() => void workbench.removeProject(7)}>
        remove runtime project
      </button>
    </div>
  )
}

function ProjectWorkPreferenceProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="current-project-id">{workbench.state.currentProject?.id ?? 'none'}</span>
      <span data-testid="project-execution-mode">{workbench.projectExecutionMode}</span>
      <span data-testid="project-worktree-branch">{workbench.projectWorktreeBranch ?? ''}</span>
      <button type="button" onClick={() => workbench.selectProjectWorkspace(7, 22)}>
        select project 7
      </button>
      <button type="button" onClick={() => workbench.selectProjectWorkspace(8, 33)}>
        select project 8
      </button>
      <button type="button" onClick={() => workbench.setProjectExecutionMode('git_worktree')}>
        use worktree
      </button>
      <button type="button" onClick={() => workbench.setProjectExecutionMode('current_workspace')}>
        use local
      </button>
      <button type="button" onClick={() => workbench.setProjectWorktreeBranch('feature/alpha')}>
        select alpha
      </button>
      <button type="button" onClick={() => workbench.setProjectWorktreeBranch('feature/beta')}>
        select beta
      </button>
    </div>
  )
}

function ArchiveRuntimeTaskProbe() {
  const workbench = useWorkbench()
  const [lastArchiveResult, setLastArchiveResult] = useState('')
  return (
    <div>
      <span data-testid="workbench-error">{workbench.state.error ?? ''}</span>
      <span data-testid="archive-result">{lastArchiveResult}</span>
      <span data-testid="current-runtime-task">
        {workbench.state.currentRuntimeTask?.taskId ?? ''}
      </span>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-b',
          })
        }
      >
        open runtime b
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench
            .archiveRuntimeTask({
              deviceId: 'device-1',
              workspacePath: '/workspace/worktrees/9/project-alpha',
              taskId: 'runtime-worktree',
            })
            .then(result => setLastArchiveResult(result?.status ?? 'none'))
        }
      >
        archive worktree task
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench
            .archiveRuntimeTask(
              {
                deviceId: 'device-1',
                workspacePath: '/workspace/worktrees/9/project-alpha',
                taskId: 'runtime-worktree',
              },
              { force: true }
            )
            .then(result => setLastArchiveResult(result?.status ?? 'none'))
        }
      >
        force archive worktree task
      </button>
    </div>
  )
}

function ArchiveProjectConversationsProbe() {
  const workbench = useWorkbench()
  const [lastArchiveResult, setLastArchiveResult] = useState('')
  return (
    <div>
      <span data-testid="workbench-error">{workbench.state.error ?? ''}</span>
      <span data-testid="archive-result">{lastArchiveResult}</span>
      <button
        type="button"
        onClick={() =>
          void workbench
            .archiveProjectsConversations(['project:7', 'remote-project-key'])
            .then(result => setLastArchiveResult(result?.status ?? 'none'))
        }
      >
        archive project conversations
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench
            .archiveProjectsConversations(['project:7', 'remote-project-key'], { force: true })
            .then(result => setLastArchiveResult(result?.status ?? 'none'))
        }
      >
        force archive project conversations
      </button>
    </div>
  )
}

function ArchiveRemoteRuntimeTaskProbe() {
  const workbench = useWorkbench()
  const taskTitles =
    workbench.state.runtimeWork?.projects.flatMap(project =>
      project.deviceWorkspaces.flatMap(workspace => workspace.tasks.map(task => task.title))
    ) ?? []
  return (
    <div>
      <span data-testid="archive-remote-task-titles">{taskTitles.join('|')}</span>
      <button
        type="button"
        onClick={() =>
          void workbench.archiveRuntimeTask({
            deviceId: 'remote-device',
            workspacePath: '/srv/Wegent',
            taskId: 'remote-task',
          })
        }
      >
        archive remote task
      </button>
    </div>
  )
}

function RuntimeOpenProbe() {
  const { workbench, paneSession, currentRuntimeTask } = useWorkbenchProbeSession()
  const [fileChangesDiff, setFileChangesDiff] = useState('')
  const [fileChangesStatus, setFileChangesStatus] = useState('')
  const fileChangesMessage = paneSession.messages.find(message => message.fileChanges)
  const fileChangesSubtaskId = fileChangesMessage?.subtaskId
  const fileChangesSummary = fileChangesMessage?.fileChanges
  return (
    <div>
      <span data-testid="current-runtime-task-address">
        {currentRuntimeTask
          ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.taskId}`
          : 'none'}
      </span>
      <span data-testid="runtime-open-messages">
        {paneSession.messages.map(message => message.content).join('|')}
      </span>
      <span data-testid="runtime-open-message-ids">
        {paneSession.messages.map(message => message.id).join('|')}
      </span>
      <span data-testid="runtime-open-message-created-at">
        {paneSession.messages.map(message => message.createdAt).join('|')}
      </span>
      <span data-testid="runtime-open-goal-flags">
        {paneSession.messages
          .filter(message => message.runtimeGoalRequest === true)
          .map(message => `goal:${message.content}`)
          .join('|') || 'none'}
      </span>
      <span data-testid="runtime-message-statuses">
        {paneSession.messages.map(message => `${message.role}:${message.status}`).join('|')}
      </span>
      <span data-testid="runtime-content-truncation">
        {paneSession.messages
          .map(
            message => `${message.id}:${message.contentTruncated === true ? 'truncated' : 'full'}`
          )
          .join('|')}
      </span>
      <span data-testid="runtime-transcript-loading">
        {paneSession.transcriptLoading ? 'loading' : 'idle'}
      </span>
      <span data-testid="runtime-transcript-has-more">
        {paneSession.transcriptHasMoreBefore ? 'more' : 'done'}
      </span>
      <span data-testid="runtime-open-blocks">
        {paneSession.messages
          .flatMap(message => message.blocks ?? [])
          .map(block => {
            if (block.type === 'tool') return `tool:${block.toolName}:${block.status}`
            if (block.type === 'thinking') return `thinking:${block.content}:${block.status}`
            return `text:${block.content}:${block.status}`
          })
          .join('|')}
      </span>
      <span data-testid="runtime-open-block-times">
        {paneSession.messages
          .flatMap(message => message.blocks ?? [])
          .map(block => block.createdAt)
          .join('|')}
      </span>
      <span data-testid="runtime-open-file-changes">
        {paneSession.messages
          .map(message => {
            if (!message.fileChanges) return ''
            const paths = message.fileChanges.files.map(file => file.path).join(',')
            const counts = `${message.fileChanges.file_count}:${message.fileChanges.additions}:${message.fileChanges.deletions}`
            return [paths, counts].filter(Boolean).join(':')
          })
          .join('|')}
      </span>
      <span data-testid="runtime-open-error">{workbench.state.error ?? ''}</span>
      <span data-testid="runtime-goal-objective">{paneSession.goal?.objective ?? 'none'}</span>
      <span data-testid="runtime-goal-status">{paneSession.goal?.status ?? 'none'}</span>
      <span data-testid="current-runtime-task-running">
        {workbench.currentRuntimeTaskRunning ? 'running' : 'idle'}
      </span>
      <span data-testid="runtime-file-changes-diff">{fileChangesDiff}</span>
      <span data-testid="runtime-file-changes-status">{fileChangesStatus}</span>
      <button
        type="button"
        onClick={() => {
          if (fileChangesSubtaskId) {
            void workbench
              .loadTurnFileChangesDiff(
                fileChangesSubtaskId,
                paneSession.messages,
                undefined,
                currentRuntimeTask
              )
              .then(setFileChangesDiff)
          }
        }}
      >
        review runtime file changes
      </button>
      <button
        type="button"
        onClick={() => {
          if (fileChangesSubtaskId && fileChangesSummary) {
            void workbench
              .loadTurnFileChangesDiff(
                fileChangesSubtaskId,
                [],
                fileChangesSummary,
                currentRuntimeTask
              )
              .then(setFileChangesDiff)
          }
        }}
      >
        review runtime file changes from stale messages
      </button>
      <button
        type="button"
        onClick={() => {
          if (fileChangesSubtaskId) {
            void workbench
              .revertTurnFileChanges(
                fileChangesSubtaskId,
                paneSession.messages,
                undefined,
                currentRuntimeTask
              )
              .then(fileChanges => setFileChangesStatus(fileChanges.status))
          }
        }}
      >
        revert runtime file changes
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-a',
          })
        }
      >
        open runtime a
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-b',
          })
        }
      >
        open runtime b
      </button>
      <button type="button" onClick={() => void paneSession.pauseCurrentResponse()}>
        stop current response
      </button>
      <button type="button" onClick={paneSession.editCurrentGoal}>
        edit runtime goal
      </button>
      <button type="button" onClick={() => paneSession.setInput('更新后的目标')}>
        set edited runtime goal
      </button>
      <button type="button" onClick={() => void paneSession.send()}>
        send runtime goal
      </button>
      <MessageList
        messages={paneSession.messages}
        isWaitingForAssistant={paneSession.status.isWaitingForAssistantIndicator}
      />
      <button type="button" onClick={() => void paneSession.loadMoreTranscriptBefore()}>
        load older
      </button>
    </div>
  )
}

function RuntimeModelCompatibilityProbe() {
  const workbench = useWorkbench()
  const modelRows = workbench.projectChat.models.map(model => {
    const disabledReason = model.compatibilityDisabledReason ?? 'enabled'
    return `${model.name}:${model.compatibilityDisabled ? disabledReason : 'enabled'}`
  })

  return (
    <div>
      <span data-testid="runtime-model-compatibility">{modelRows.join('|')}</span>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-a',
          })
        }
      >
        open runtime a
      </button>
    </div>
  )
}

function RuntimeModelSelectionProbe() {
  const workbench = useWorkbench()
  const mimoModel = workbench.projectChat.models.find(model => model.name === 'local-model:mimo')

  return (
    <div>
      <span data-testid="selected-model">{workbench.projectChat.selectedModel?.name ?? ''}</span>
      <span data-testid="selected-mode">
        {workbench.projectChat.selectedModelOptions.collaborationMode ?? 'default'}
      </span>
      <button
        type="button"
        onClick={() => {
          if (mimoModel) workbench.projectChat.setSelectedModel(mimoModel)
        }}
      >
        select mimo
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-a',
          })
        }
      >
        open runtime a
      </button>
    </div>
  )
}

function FollowUpProbe() {
  const { workbench, paneSession, currentRuntimeTask } = useWorkbenchProbeSession()
  const imageAttachment = createImageAttachment()
  const localImageAttachment = createLocalImageAttachment()
  const firstQueuedMessage = paneSession.queuedMessages[0]
  const gptModel =
    workbench.projectChat.models.find(model => model.name === 'gpt-5-2025-08-07') ?? null

  return (
    <div>
      <span data-testid="composer-input">{paneSession.input}</span>
      <span data-testid="queued-messages">
        {paneSession.queuedMessages
          .map(message => `${message.status}:${message.content}`)
          .join('|')}
      </span>
      <span data-testid="queued-message-ids">
        {paneSession.queuedMessages.map(message => message.id).join('|')}
      </span>
      <span data-testid="queued-message-created-at">
        {paneSession.queuedMessages.map(message => message.createdAt).join('|')}
      </span>
      <span data-testid="queued-errors">
        {paneSession.queuedMessages.map(message => message.error ?? '').join('|')}
      </span>
      <span data-testid="queued-notices">
        {paneSession.queuedMessages.map(message => message.notice ?? '').join('|')}
      </span>
      <span data-testid="runtime-attachment-count">{workbench.projectChat.attachments.length}</span>
      <span data-testid="code-comment-context-count">{paneSession.codeCommentContexts.length}</span>
      <span data-testid="follow-up-current-runtime-task">
        {currentRuntimeTask
          ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.taskId}`
          : 'none'}
      </span>
      <span data-testid="follow-up-models">
        {workbench.projectChat.models.map(model => model.name).join('|')}
      </span>
      <span data-testid="follow-up-model-statuses">
        {workbench.projectChat.models
          .map(model => `${model.name}:${model.compatibilityDisabledReason ?? 'enabled'}`)
          .join('|')}
      </span>
      <span data-testid="follow-up-selected-model">
        {workbench.projectChat.selectedModel?.name ?? ''}
      </span>
      <span data-testid="follow-up-collaboration-mode">
        {workbench.projectChat.selectedModelOptions.collaborationMode ?? 'default'}
      </span>
      <span data-testid="guidance-messages">
        {paneSession.guidanceMessages
          .map(message => `${message.status}:${message.content}`)
          .join('|')}
      </span>
      <span data-testid="follow-up-messages">
        {paneSession.messages.map(message => `${message.role}:${message.content}`).join('|')}
      </span>
      <span data-testid="follow-up-pane-busy">{paneSession.status.isBusy ? 'busy' : 'idle'}</span>
      <button type="button" onClick={() => paneSession.setInput('继续修')}>
        set follow-up
      </button>
      <button type="button" onClick={() => paneSession.setInput('执行ls')}>
        set ls follow-up
      </button>
      <button
        data-testid="follow-up-add-code-comment"
        type="button"
        onClick={() =>
          paneSession.addCodeComment({
            id: 'comment-1',
            filePath: '/workspace/project-alpha/src/main.ts',
            fileName: 'main.ts',
            startLine: 1,
            endLine: 1,
            selectedText: 'const value = 1',
            comment: 'keep this context',
            createdAt: '2026-07-19T00:00:00.000Z',
          })
        }
      >
        add code comment
      </button>
      <button type="button" onClick={() => void paneSession.setCurrentGoal()}>
        set follow-up goal
      </button>
      <button
        type="button"
        onClick={() => {
          if (gptModel) workbench.projectChat.setSelectedModel(gptModel)
        }}
      >
        select gpt model
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.setSelectedModelOption('collaborationMode', 'plan')}
      >
        enable follow-up plan mode
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.setSelectedModelOption('collaborationMode', 'default')}
      >
        disable follow-up plan mode
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.addExistingAttachment(imageAttachment)}
      >
        add image attachment
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.addExistingAttachment(localImageAttachment)}
      >
        add local image attachment
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-a',
          })
        }
      >
        open follow-up runtime a
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-b',
          })
        }
      >
        open follow-up runtime b
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.archiveRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-a',
          })
        }
      >
        archive follow-up runtime a
      </button>
      <button type="button" onClick={() => workbench.selectProject(null)}>
        return standalone follow-up
      </button>
      <button type="button" onClick={() => workbench.startNewChat()}>
        sidebar new follow-up chat
      </button>
      <button type="button" onClick={() => void paneSession.send()}>
        send follow-up
      </button>
      <button
        type="button"
        onClick={() => void paneSession.send(undefined, { guideWhenBusy: true })}
      >
        send follow-up as guidance
      </button>
      <button
        data-testid="follow-up-interrupt-and-send"
        type="button"
        onClick={() => void paneSession.send(undefined, { interruptWhenBusy: true })}
      >
        interrupt and send follow-up
      </button>
      <button
        type="button"
        onClick={() =>
          void paneSession.sendRequestUserInputResponse(
            {
              answers: {
                implement: { answers: ['是的，执行此计划'] },
              },
            },
            { appendUserMessage: true, forceDefaultCollaborationMode: true }
          )
        }
      >
        submit implementation confirmation
      </button>
      <button type="button" onClick={() => void workbench.refreshWorkLists()}>
        refresh work lists
      </button>
      <button
        type="button"
        onClick={() => {
          if (firstQueuedMessage) paneSession.editQueuedMessage(firstQueuedMessage.id)
        }}
      >
        edit first queued
      </button>
      <button
        type="button"
        onClick={() => {
          if (firstQueuedMessage) void paneSession.sendQueuedAsGuidance(firstQueuedMessage.id)
        }}
      >
        guide first queued
      </button>
      <button
        data-testid="queued-interrupt-and-send-first"
        type="button"
        onClick={() => {
          if (firstQueuedMessage) void paneSession.interruptAndSendQueued(firstQueuedMessage.id)
        }}
      >
        interrupt first queued
      </button>
    </div>
  )
}

function RuntimeTaskSkillsProbe() {
  const workbench = useWorkbench()
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeTask({
            deviceId: 'runtime-device',
            workspacePath: '/workspace/runtime-device',
            taskId: 'runtime-skill-task',
          })
        }
      >
        open runtime skill task
      </button>
      <button type="button" onClick={() => void workbench.projectChat.listLocalSkills()}>
        list local skills
      </button>
      <button type="button" onClick={() => void workbench.projectChat.listLocalApps()}>
        list local apps
      </button>
    </div>
  )
}

function StartSkillChatProbe() {
  const workbench = useWorkbench()
  const [result, setResult] = useState('not-started')

  return (
    <div>
      <span data-testid="available-skill-names">
        {workbench.projectChat.skills.map(skill => skill.name).join('|')}
      </span>
      <span data-testid="selected-skill-refs">
        {workbench.projectChat.selectedSkills
          .map(skill => `${skill.namespace}:${skill.name}:${String(skill.is_public)}`)
          .join('|')}
      </span>
      <span data-testid="skill-chat-key">{workbench.state.standaloneChatKey}</span>
      <span data-testid="skill-chat-start-result">{result}</span>
      <span data-testid="skill-chat-input">{workbench.projectChat.input}</span>
      <button
        type="button"
        onClick={() =>
          void Promise.resolve(workbench.startNewSkillChat(['sites:sites-building'])).then(
            started => setResult(started ? 'started' : 'missing')
          )
        }
      >
        start sites chat
      </button>
      <button
        type="button"
        onClick={() =>
          void Promise.resolve(
            workbench.startNewSkillChat(['sites:sites-building'], { allowLocalSkills: false })
          ).then(started => setResult(started ? 'started' : 'missing'))
        }
      >
        start backend sites chat
      </button>
    </div>
  )
}

describe('WorkbenchProvider runtime tasks', () => {
  beforeEach(() => {
    vi.useRealTimers()
    delete window.__WEWORK_RUNTIME_CONFIG__
    clearTauriRuntime()
    window.history.pushState({}, '', '/')
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
    localExecutorMocks.ensureLocalExecutorStarted.mockResolvedValue({
      running: true,
      ready: true,
      deviceId: 'local-device',
    })
    localExecutorMocks.requestLocalExecutor.mockImplementation(async (method: string) => {
      if (method === 'runtime.tasks.list') {
        return { projects: [], chats: [], totalTasks: 0 }
      }
      return {}
    })
    localExecutorMocks.subscribeLocalExecutorEvents.mockResolvedValue(vi.fn())
  })

  test('bootstraps with local app services in local-first runtime mode', async () => {
    setTauriRuntime()
    window.__WEWORK_RUNTIME_CONFIG__ = {
      runtimeMode: 'local-first',
    }

    renderWorkbenchWithDefaultServices(<BootstrapProbe />)

    await waitFor(() => expect(screen.getByTestId('boot-state')).toHaveTextContent('local'))
    await waitFor(() => expect(screen.getByTestId('startup-ready')).toHaveTextContent('ready'), {
      timeout: 3000,
    })
    expect(screen.getByTestId('project-count')).toHaveTextContent('0')
    expect(screen.getByTestId('runtime-total')).toHaveTextContent('0')
    expect(localExecutorMocks.ensureLocalExecutorStarted).toHaveBeenCalled()
    expect(localExecutorMocks.requestLocalExecutor).toHaveBeenCalledWith('runtime.tasks.list', {})
  })

  test('bootstraps projects and runtime work without DB task APIs', async () => {
    const services = createWorkbenchServices()

    renderWorkbench(<BootstrapProbe />, services)

    await waitFor(() => expect(screen.getByTestId('boot-state')).toHaveTextContent('alice'))
    await waitFor(() => expect(screen.getByTestId('startup-ready')).toHaveTextContent('ready'))
    expect(screen.getByTestId('project-count')).toHaveTextContent('0')
    expect(screen.getByTestId('runtime-total')).toHaveTextContent('3')
    expect(services.projectApi.listProjects).not.toHaveBeenCalled()
    expect(services.runtimeWorkApi?.listRuntimeWork).toHaveBeenCalledTimes(1)
  })

  test('starts a fresh blank chat with a requested loaded skill selected', async () => {
    const services = createWorkbenchServices({
      skillApi: {
        listSkills: vi.fn().mockResolvedValue([
          {
            id: 101,
            name: 'sites-building',
            namespace: 'sites',
            description: 'Build websites with Sites',
            is_active: true,
            is_public: false,
            user_id: 1,
          },
        ]),
        getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
      },
    })
    renderWorkbench(<StartSkillChatProbe />, services)
    await waitFor(() =>
      expect(screen.getByTestId('available-skill-names')).toHaveTextContent('sites-building')
    )

    await userEvent.click(screen.getByRole('button', { name: 'start sites chat' }))

    expect(screen.getByTestId('skill-chat-start-result')).toHaveTextContent('started')
    expect(screen.getByTestId('skill-chat-key')).toHaveTextContent('1')
    expect(screen.getByTestId('selected-skill-refs')).toHaveTextContent(
      'sites:sites-building:false'
    )
    expect(screen.getByTestId('skill-chat-input')).toHaveTextContent('')
  })

  test('starts a fresh blank chat with a requested local skill mentioned', async () => {
    setTauriRuntime()
    localExecutorMocks.requestLocalExecutor.mockImplementation(
      async (method: string, params?: unknown) => {
        if (method === 'runtime.tasks.list') {
          return { projects: [], chats: [], totalTasks: 0 }
        }
        if (
          method === 'codex.app_server_request' &&
          params &&
          typeof params === 'object' &&
          (params as { method?: unknown }).method === 'skills/list'
        ) {
          return {
            data: [
              {
                cwd: '',
                skills: [
                  {
                    name: 'sites:sites-building',
                    description: 'Build websites with Sites',
                    path: '/Users/alice/.codex/plugins/sites/skills/sites-building/SKILL.md',
                    scope: 'user',
                    source: 'codex-plugin',
                    enabled: true,
                  },
                ],
                errors: [],
              },
            ],
          }
        }
        return {}
      }
    )

    renderWorkbench(<StartSkillChatProbe />)

    await userEvent.click(screen.getByRole('button', { name: 'start sites chat' }))

    await waitFor(() =>
      expect(screen.getByTestId('skill-chat-start-result')).toHaveTextContent('started')
    )
    expect(screen.getByTestId('skill-chat-key')).toHaveTextContent('1')
    expect(screen.getByTestId('selected-skill-refs')).toHaveTextContent('')
    expect(screen.getByTestId('skill-chat-input')).toHaveTextContent(
      '[$sites](/Users/alice/.codex/plugins/sites/skills/sites-building/SKILL.md)'
    )
    expect(localExecutorMocks.requestLocalExecutor).toHaveBeenCalledWith(
      'codex.app_server_request',
      {
        method: 'skills/list',
        params: { cwds: [], forceReload: true },
      }
    )
  })

  test('does not resolve local skills for a Backend-only skill chat', async () => {
    setTauriRuntime()
    localExecutorMocks.requestLocalExecutor.mockImplementation(
      async (method: string, params?: unknown) => {
        if (method === 'runtime.tasks.list') {
          return { projects: [], chats: [], totalTasks: 0 }
        }
        if (
          method === 'codex.app_server_request' &&
          params &&
          typeof params === 'object' &&
          (params as { method?: unknown }).method === 'skills/list'
        ) {
          return {
            data: [
              {
                cwd: '',
                skills: [
                  {
                    name: 'sites:sites-building',
                    description: 'Build websites with Sites',
                    path: '/Users/alice/.codex/plugins/sites/skills/sites-building/SKILL.md',
                    scope: 'user',
                    enabled: true,
                  },
                ],
                errors: [],
              },
            ],
          }
        }
        return {}
      }
    )

    renderWorkbench(<StartSkillChatProbe />)

    await userEvent.click(screen.getByRole('button', { name: 'start backend sites chat' }))

    await waitFor(() =>
      expect(screen.getByTestId('skill-chat-start-result')).toHaveTextContent('missing')
    )
    expect(localExecutorMocks.requestLocalExecutor).not.toHaveBeenCalledWith(
      'codex.app_server_request',
      expect.objectContaining({ method: 'skills/list' })
    )
  })

  test('does not leave the current view when a requested skill is unavailable', async () => {
    renderWorkbench(<StartSkillChatProbe />)
    window.history.pushState({}, '', '/sites')

    await userEvent.click(screen.getByRole('button', { name: 'start sites chat' }))

    await waitFor(() =>
      expect(screen.getByTestId('skill-chat-start-result')).toHaveTextContent('missing')
    )
    expect(screen.getByTestId('skill-chat-key')).toHaveTextContent('0')
    expect(window.location.pathname).toBe('/sites')
  })

  test('does not poll runtime work after bootstrap', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const emptyRuntimeWork = createRuntimeWork({
        projects: [],
        chats: [],
        totalTasks: 0,
      })
      const refreshedRuntimeWork = createRuntimeWork({
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            deviceWorkspaces: [
              {
                id: 22,
                projectId: 7,
                deviceId: 'device-1',
                deviceName: 'Project Device',
                deviceStatus: 'online',
                workspacePath: '/workspace/project-alpha',
                mapped: true,
                available: true,
                tasks: [
                  {
                    taskId: 'runtime-created-elsewhere',
                    workspacePath: '/workspace/project-alpha',
                    title: 'Created elsewhere',
                    runtime: 'codex',
                  },
                ],
              },
            ],
            totalTasks: 1,
          },
        ],
        chats: [],
        totalTasks: 1,
      })
      const listRuntimeWork = vi
        .fn()
        .mockResolvedValueOnce(emptyRuntimeWork)
        .mockResolvedValue(refreshedRuntimeWork)
      const services = createWorkbenchServices({
        runtimeWorkApi: createRuntimeWorkApiMock({ listRuntimeWork }),
      })

      renderWorkbench(<BootstrapProbe />, services)

      await waitFor(() => expect(screen.getByTestId('runtime-total')).toHaveTextContent('0'))
      expect(listRuntimeWork).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(listRuntimeWork).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('runtime-total')).toHaveTextContent('0')
    } finally {
      vi.useRealTimers()
    }
  })

  test('marks successful empty cloud devices as empty instead of unavailable', async () => {
    const services = createWorkbenchServices({
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([]),
        listRuntimeWork: vi.fn().mockResolvedValue({ projects: [], chats: [], totalTasks: 0 }),
      },
    })

    renderWorkbench(<CloudWorkStatusProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('cloud-work-availability')).toHaveTextContent('empty')
    )
    expect(screen.getByTestId('cloud-work-devices-check')).toHaveTextContent('empty')
    expect(screen.getByTestId('cloud-work-error')).toHaveTextContent('')
  })

  test('restores cached remote task summaries when the device is offline at startup', async () => {
    writeCachedRemoteRuntimeWork(1, {
      projects: [
        {
          project: { key: '/srv/Wegent', name: 'Remote Wegent' },
          deviceWorkspaces: [
            {
              deviceId: 'remote-device',
              deviceName: '10.201.3.200',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/srv/Wegent',
              tasks: [
                {
                  taskId: 'remote-cached-task',
                  workspacePath: '/srv/Wegent',
                  title: 'Cached remote task',
                  runtime: 'codex',
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({
        listRuntimeWork: vi.fn().mockResolvedValue({
          projects: [
            {
              project: {
                key: 'remote-project-id',
                sidebarStateKey: 'remote-project-id',
                name: 'Remote Wegent',
                kind: 'remote',
                source: 'remote_project',
                stateDeviceId: 'local-device',
              },
              deviceWorkspaces: [
                {
                  deviceId: 'remote-device',
                  deviceName: '127.0.0.1',
                  deviceStatus: 'offline',
                  available: false,
                  workspacePath: '/srv/Wegent',
                  workspaceSource: 'remote',
                  remoteHostId: 'remote-device',
                  mapped: true,
                  tasks: [],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 0,
        }),
      }),
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([
          createDevice({
            id: 2,
            device_id: 'remote-device',
            name: '10.201.3.200',
            status: 'offline',
            is_default: false,
            device_type: 'remote',
          }),
        ]),
        listRuntimeWork: vi.fn().mockResolvedValue({
          projects: [],
          chats: [],
          totalTasks: 0,
        }),
      },
    })

    renderWorkbench(<RemoteRuntimeCacheProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('cached-runtime-task-titles')).toHaveTextContent(
        'Cached remote task'
      )
    )
    expect(screen.getByTestId('cached-runtime-workspace-availability')).toHaveTextContent('false')
    expect(screen.getByTestId('cached-runtime-device-names')).toHaveTextContent('10.201.3.200')
  })

  test('hides remote work on disconnect and restores it when the cloud reconnects', async () => {
    writeCachedRemoteRuntimeWork(1, {
      projects: [
        {
          project: { key: '/srv/Wegent', name: 'Remote Wegent' },
          deviceWorkspaces: [
            {
              deviceId: 'remote-device',
              deviceName: '10.201.3.200',
              deviceStatus: 'offline',
              available: false,
              workspacePath: '/srv/Wegent',
              workspaceSource: 'remote',
              remoteHostId: 'remote-device',
              tasks: [
                {
                  taskId: 'remote-cached-task',
                  workspacePath: '/srv/Wegent',
                  title: 'Cached remote task',
                  runtime: 'codex',
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    })
    const localRuntimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: {
            key: 'remote-project-id',
            sidebarStateKey: 'remote-project-id',
            name: 'Remote Wegent',
            kind: 'remote',
            source: 'remote_project',
            stateDeviceId: 'local-device',
          },
          deviceWorkspaces: [
            {
              deviceId: 'remote-device',
              deviceName: '127.0.0.1',
              deviceStatus: 'offline',
              available: false,
              workspacePath: '/srv/Wegent',
              workspaceSource: 'remote',
              remoteHostId: 'remote-device',
              mapped: true,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
        {
          project: { key: 'local-project-id', name: 'Local Wegent' },
          deviceWorkspaces: [
            {
              deviceId: 'local-device',
              deviceName: 'Local Mac',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/Users/alice/Wegent',
              workspaceSource: 'local',
              mapped: true,
              tasks: [
                {
                  taskId: 'local-task',
                  workspacePath: '/Users/alice/Wegent',
                  title: 'Local task',
                  runtime: 'codex',
                },
              ],
            },
          ],
          totalTasks: 1,
        },
      ],
      chats: [],
      totalTasks: 1,
    }
    const createServices = (connected: boolean) =>
      createWorkbenchServices({
        deviceApi: {
          listDevices: vi.fn().mockResolvedValue([
            createDevice({
              device_id: 'local-device',
              name: 'Local Mac',
              device_type: 'local',
            }),
          ]),
        } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
        runtimeWorkApi: createRuntimeWorkApiMock({
          listRuntimeWork: vi.fn().mockResolvedValue(localRuntimeWork),
        }),
        cloudBackgroundApi: connected
          ? {
              listTeams: vi.fn().mockResolvedValue([]),
              listDevices: vi.fn().mockResolvedValue([
                createDevice({
                  id: 2,
                  device_id: 'remote-device',
                  name: '10.201.3.200',
                  status: 'offline',
                  is_default: false,
                  device_type: 'remote',
                }),
              ]),
              listRuntimeWork: vi.fn().mockResolvedValue({
                projects: [],
                chats: [],
                totalTasks: 0,
              }),
            }
          : undefined,
      })
    const renderTree = (services: WorkbenchServices) => (
      <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
        <WorkbenchProbeSessionProvider>
          <RemoteRuntimeCacheProbe />
        </WorkbenchProbeSessionProvider>
      </WorkbenchProvider>
    )
    const disconnectedServices = createServices(false)
    const connectedServices = createServices(true)
    const rendered = render(renderTree(disconnectedServices))

    await waitFor(() =>
      expect(screen.getByTestId('cached-runtime-project-names')).toHaveTextContent('Local Wegent')
    )
    expect(screen.getByTestId('cached-runtime-project-names')).not.toHaveTextContent(
      'Remote Wegent'
    )
    expect(screen.getByTestId('cached-runtime-task-titles')).toHaveTextContent('Local task')
    expect(screen.getByTestId('cached-runtime-task-titles')).not.toHaveTextContent(
      'Cached remote task'
    )

    rendered.rerender(renderTree(connectedServices))

    await waitFor(() =>
      expect(screen.getByTestId('cached-runtime-project-names')).toHaveTextContent('Remote Wegent')
    )
    expect(screen.getByTestId('cached-runtime-task-titles')).toHaveTextContent('Cached remote task')
    expect(screen.getByTestId('cached-runtime-device-names')).toHaveTextContent('10.201.3.200')

    rendered.rerender(renderTree(disconnectedServices))

    await waitFor(() => {
      expect(screen.getByTestId('cached-runtime-project-names')).not.toHaveTextContent(
        'Remote Wegent'
      )
      expect(screen.getByTestId('cached-runtime-task-titles')).not.toHaveTextContent(
        'Cached remote task'
      )
    })

    rendered.rerender(renderTree(connectedServices))

    await waitFor(() =>
      expect(screen.getByTestId('cached-runtime-task-titles')).toHaveTextContent(
        'Cached remote task'
      )
    )
  })

  test('applies device online events immediately when refresh falls back would be stale', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return vi.fn()
    })
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce([createDevice({ status: 'offline' })])
      .mockRejectedValue(new Error('network unavailable'))
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices,
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<DeviceStatusProbe />, services)

    await waitFor(() => expect(screen.getByTestId('device-status')).toHaveTextContent('offline'))

    await act(async () => {
      streamHandlers.onDeviceOnline?.({
        device_id: 'device-1',
        name: 'Project Device',
      })
    })

    expect(screen.getByTestId('device-status')).toHaveTextContent('online')
  })

  test('ensures the chat socket is connected while mounted', async () => {
    const socketClient = {
      ensureConnected: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    }
    const services = createWorkbenchServices({
      socketClient,
    } as Partial<WorkbenchServices>)

    const { unmount } = renderWorkbench(<BootstrapProbe />, services)

    await waitFor(() => expect(socketClient.ensureConnected).toHaveBeenCalledTimes(1))
    expect(socketClient.dispose).not.toHaveBeenCalled()

    unmount()

    expect(socketClient.dispose).toHaveBeenCalledTimes(1)
  })

  test('restores project execution mode and worktree branch per project preference', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, key: 'project:7', name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
            {
              project: { id: 8, key: 'project:8', name: 'Docs' },
              deviceWorkspaces: [
                {
                  id: 33,
                  projectId: 8,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-beta',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
          ],
          totalTasks: 0,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })
    const user: User = {
      id: 1,
      user_name: 'alice',
      email: 'a@b.c',
      preferences: {
        wework_project_work_preferences: {
          'project:7': {
            executionMode: 'git_worktree',
            worktreeBranch: 'feature/alpha',
          },
          'project:8': {
            executionMode: 'current_workspace',
            worktreeBranch: 'feature/beta',
          },
        },
      },
    }

    renderWorkbenchForUser(<ProjectWorkPreferenceProbe />, user, services)

    await waitFor(() => expect(screen.getByText('select project 7')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project 7'))

    await waitFor(() => expect(screen.getByTestId('current-project-id')).toHaveTextContent('7'))
    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('git_worktree')
    )
    expect(screen.getByTestId('project-worktree-branch')).toHaveTextContent('feature/alpha')

    await userEvent.click(screen.getByText('select project 8'))

    await waitFor(() => expect(screen.getByTestId('current-project-id')).toHaveTextContent('8'))
    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('current_workspace')
    )
    expect(screen.getByTestId('project-worktree-branch')).toHaveTextContent('feature/beta')
  })

  test('keeps newly selected project execution preferences isolated by project', async () => {
    const updateCurrentUser = vi.fn().mockResolvedValue({})
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, key: 'project:7', name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
            {
              project: { id: 8, key: 'project:8', name: 'Docs' },
              deviceWorkspaces: [
                {
                  id: 33,
                  projectId: 8,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-beta',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
          ],
          totalTasks: 0,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      userApi: {
        updateCurrentUser,
      } as Partial<WorkbenchServices['userApi']> as WorkbenchServices['userApi'],
    })

    renderWorkbench(<ProjectWorkPreferenceProbe />, services)

    await waitFor(() => expect(screen.getByText('select project 7')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project 7'))
    await waitFor(() => expect(screen.getByTestId('current-project-id')).toHaveTextContent('7'))
    await userEvent.click(screen.getByText('use worktree'))
    await userEvent.click(screen.getByText('select alpha'))

    await waitFor(() =>
      expect(updateCurrentUser).toHaveBeenLastCalledWith({
        preferences: expect.objectContaining({
          wework_project_work_preferences: expect.objectContaining({
            'project:7': {
              executionMode: 'git_worktree',
              worktreeBranch: 'feature/alpha',
            },
          }),
        }),
      })
    )

    await userEvent.click(screen.getByText('select project 8'))

    await waitFor(() => expect(screen.getByTestId('current-project-id')).toHaveTextContent('8'))
    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('current_workspace')
    )
    expect(screen.getByTestId('project-worktree-branch')).toHaveTextContent('')

    await userEvent.click(screen.getByText('use worktree'))
    await userEvent.click(screen.getByText('select beta'))
    await userEvent.click(screen.getByText('select project 7'))

    await waitFor(() => expect(screen.getByTestId('current-project-id')).toHaveTextContent('7'))
    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('git_worktree')
    )
    expect(screen.getByTestId('project-worktree-branch')).toHaveTextContent('feature/alpha')

    await userEvent.click(screen.getByText('select project 8'))

    await waitFor(() => expect(screen.getByTestId('current-project-id')).toHaveTextContent('8'))
    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('git_worktree')
    )
    expect(screen.getByTestId('project-worktree-branch')).toHaveTextContent('feature/beta')
  })

  test('locks existing runtime task model choices to its runtime protocol', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'wecode-claude-sonnet-4-5',
        type: 'public',
        runtime: { family: 'claude.claude' },
      },
      {
        name: 'kimi-k2.5',
        type: 'public',
        runtime: { family: 'claude.claude' },
      },
      {
        name: 'codex-gpt-5.5',
        type: 'runtime',
        runtime: { family: 'openai.openai-responses' },
      },
      {
        name: 'gpt-5-2025-08-07',
        type: 'public',
        displayName: '海外:gpt-5-2025-08-07',
        provider: 'openai',
        runtime: { family: 'openai', provider: 'openai' },
      },
    ]
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelCompatibilityProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-model-compatibility')).toHaveTextContent(
        [
          'wecode-claude-sonnet-4-5:enabled',
          'kimi-k2.5:enabled',
          'codex-gpt-5.5:runtime_family_mismatch',
          'gpt-5-2025-08-07:runtime_family_mismatch',
        ].join('|')
      )
    )
  })

  test('keeps ChatGPT models selectable inside existing Codex runtime tasks', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'codex-gpt-5.5',
        type: 'runtime',
        runtime: { family: 'openai.openai-responses' },
      },
      {
        name: 'gpt-5-2025-08-07',
        type: 'public',
        displayName: '海外:gpt-5-2025-08-07',
        provider: 'openai',
        runtime: { family: 'openai', provider: 'openai' },
      },
      {
        name: 'wecode-claude-sonnet-4-5',
        type: 'public',
        runtime: { family: 'claude.claude' },
      },
    ]
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelCompatibilityProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-model-compatibility')).toHaveTextContent(
        [
          'codex-gpt-5.5:enabled',
          'gpt-5-2025-08-07:enabled',
          'wecode-claude-sonnet-4-5:runtime_family_mismatch',
        ].join('|')
      )
    )
  })

  test('persists blank new chat model selection as the next default', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'gpt-5.5',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-provider',
          ui: { family: 'codex-provider', controls: ['collaborationMode'] },
        },
        runtime: { family: 'openai.openai-responses' },
      },
      {
        name: 'local-model:mimo',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'model-interface',
          ui: { family: 'model-interface', controls: ['collaborationMode'] },
        },
        runtime: { family: 'openai.openai-responses' },
      },
    ]
    const updateCurrentUser = vi.fn().mockResolvedValue({})
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      userApi: {
        updateCurrentUser,
      } as Partial<WorkbenchServices['userApi']> as WorkbenchServices['userApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelSelectionProbe />, services)

    await waitFor(() => expect(screen.getByTestId('selected-model')).toHaveTextContent('gpt-5.5'))
    await userEvent.click(screen.getByText('select mimo'))

    await waitFor(() =>
      expect(updateCurrentUser).toHaveBeenCalledWith({
        preferences: expect.objectContaining({
          wework_new_chat_model_selection: expect.objectContaining({
            modelName: 'local-model:mimo',
            modelType: 'runtime',
          }),
        }),
      })
    )
  })

  test('restores runtime task model selection without overwriting the new chat default', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'gpt-5.5',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-provider',
          ui: { family: 'codex-provider', controls: ['collaborationMode'] },
        },
        runtime: { family: 'openai.openai-responses' },
      },
      {
        name: 'local-model:mimo',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'model-interface',
          ui: { family: 'model-interface', controls: ['collaborationMode'] },
        },
        runtime: { family: 'openai.openai-responses' },
      },
    ]
    const updateCurrentUser = vi.fn().mockResolvedValue({})
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'codex',
                      modelSelection: {
                        modelName: 'local-model:mimo',
                        modelType: 'runtime',
                        options: { collaborationMode: 'plan' },
                      },
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      userApi: {
        updateCurrentUser,
      } as Partial<WorkbenchServices['userApi']> as WorkbenchServices['userApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelSelectionProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('selected-model')).toHaveTextContent('local-model:mimo')
    )
    expect(screen.getByTestId('selected-mode')).toHaveTextContent('plan')
    await userEvent.click(screen.getByText('select mimo'))
    expect(updateCurrentUser).not.toHaveBeenCalled()
  })

  test('creates a runtime task for a new project message', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'claude_code',
      })),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTranscriptRequest) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        runtime: 'claude_code',
        messages: [],
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        teamId: 2,
        message: '修复 CI',
      })
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('projectId')
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty(
      'deviceWorkspaceId'
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('task_id')
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}`
      )
    )
    // The optimistic user message stays in place while the empty new-task
    // transcript loads.
    expect(screen.getByTestId('message-roles')).toHaveTextContent('user:修复 CI')
    expect(runtimeWorkApi.getRuntimeTranscript).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      taskId: request.taskId,
      limit: 50,
    })
    expect(parseRuntimeTaskRoute(window.location.pathname, window.location.search)).toEqual({
      deviceId: 'device-1',
      taskId: request.taskId,
    })
  })

  test('restores and records the active project from Codex global state metadata', async () => {
    const activateRuntimeProject = vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { key: '/workspace/project-alpha', id: 7, name: 'Wegent', active: true },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Local Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
          ],
          totalTasks: 0,
        })
      ),
      activateRuntimeProject,
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([createDevice({ device_type: 'local' })]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    )
    await waitFor(() =>
      expect(activateRuntimeProject).toHaveBeenCalledWith({
        deviceId: 'device-1',
        projectKey: '/workspace/project-alpha',
        workspacePath: '/workspace/project-alpha',
      })
    )
  })

  test('restores the last used project before starting a new task', async () => {
    writeLastProjectId(1, 7)
    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() =>
      expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    )

    await userEvent.click(screen.getByText('start new chat'))

    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
  })

  test('starts a new task in the project of the last opened task', async () => {
    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-project-order')).toHaveTextContent('Wegent')
    )
    await userEvent.click(screen.getByText('open project runtime task'))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      'device-1:runtime-a'
    )

    await userEvent.click(screen.getByText('start new chat'))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
  })

  test('keeps a standalone new task unassigned when starting another new task', async () => {
    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-project-order')).toHaveTextContent('Wegent')
    )
    await userEvent.click(screen.getByText('select project'))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')

    await userEvent.click(screen.getByText('start standalone chat'))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('none')
    expect(readLastProjectId(1)).toBeNull()

    await userEvent.click(screen.getByText('start new chat'))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('none')
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
  })

  test('falls back to a standalone new task when the last project no longer exists', async () => {
    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-project-order')).toHaveTextContent('Wegent')
    )
    writeLastProjectId(1, 999)

    await userEvent.click(screen.getByText('start new chat'))

    expect(screen.getByTestId('current-project-name')).toHaveTextContent('none')
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
  })

  test('does not reopen a newly created task after the user switches tasks', async () => {
    const createResponse = deferred<RuntimeTaskCreateResponse>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-b',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime B',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      createRuntimeTask: vi.fn(() => createResponse.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))
    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const optimisticRequest = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]

    await userEvent.click(screen.getByText('open runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-b'
      )
    )

    await act(async () => {
      createResponse.resolve({
        accepted: true,
        deviceId: 'device-1',
        taskId: optimisticRequest.taskId,
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
      })
      await createResponse.promise
    })

    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      'device-1:runtime-b'
    )
    expect(parseRuntimeTaskRoute(window.location.pathname, window.location.search)).toEqual({
      deviceId: 'device-1',
      taskId: 'runtime-b',
    })
  })

  test('keeps a failed runtime task record when project task creation is rejected', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn(async request => ({
        accepted: false,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'claude_code',
        error: 'executor-not-found:device-1',
      })),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTranscriptRequest) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        runtime: 'claude_code',
        messages: [],
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}`
      )
    )
    expect(screen.getByTestId('runtime-task-titles')).toHaveTextContent('修复 CI')
    expect(screen.getByTestId('runtime-task-statuses')).toHaveTextContent('failed')
    expect(screen.getByTestId('runtime-task-errors')).toHaveTextContent(
      'executor-not-found:device-1'
    )
  })

  test('keeps new runtime task model selection for context usage window resolution', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const models: UnifiedModel[] = [
      {
        name: 'local-model:mimo',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'model-interface',
          model_context_window: 1_000_000,
          ui: { family: 'model-interface', controls: ['collaborationMode'] },
        },
        runtime: { family: 'openai.openai-responses' },
      },
    ]
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  deviceName: 'Local Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'codex',
      })),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTranscriptRequest) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        runtime: 'codex',
        messages: [],
      })),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([createDevice({ device_type: 'local' })]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}`
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-model-selection')).toHaveTextContent(
        'local-model:mimo:runtime:'
      )
    )
    await waitFor(() => expect(streamHandlers.onChatDone).toBeDefined())

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: request.taskId,
        subtaskId: '102',
        result: {
          value: 'done',
          contextUsage: {
            total: {
              totalTokens: 43_300,
              inputTokens: 43_000,
              cachedInputTokens: 0,
              outputTokens: 300,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 43_300,
              inputTokens: 43_000,
              cachedInputTokens: 0,
              outputTokens: 300,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 258_400,
          },
        },
        deviceId: 'device-1',
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-context-window')).toHaveTextContent('1000000')
    )
  })

  test('creates a goal-first runtime task for a new project message', async () => {
    const createRuntimeTask =
      deferred<
        Awaited<ReturnType<NonNullable<WorkbenchServices['runtimeWorkApi']>['createRuntimeTask']>>
      >()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 11,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn().mockReturnValue(createRuntimeTask.promise),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTranscriptRequest) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        runtime: 'codex',
        messages: [],
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set goal'))
    expect(screen.getByTestId('goal-draft-active')).toHaveTextContent('active')
    await userEvent.click(screen.getByText('set input'))

    expect(screen.getByTestId('goal-objective')).toHaveTextContent('none')

    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMessageId: expect.stringMatching(/^runtime-local-pane-/),
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('goal-draft-active')).toHaveTextContent('inactive')
    )
    expect(screen.getByTestId('goal-objective')).toHaveTextContent('修复 CI')
    expect(screen.getByTestId('message-goal-flags')).toHaveTextContent('goal:修复 CI')
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 7,
        deviceWorkspaceId: 11,
        teamId: 2,
        message: '修复 CI',
        initialGoal: {
          objective: '修复 CI',
          status: 'active',
          tokenBudget: null,
        },
      })
    )
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await act(async () => {
      createRuntimeTask.resolve({
        accepted: true,
        deviceId: 'device-1',
        taskId: request.taskId,
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
      })
      await createRuntimeTask.promise
    })
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}`
      )
    )
    expect(screen.getByTestId('goal-objective')).toHaveTextContent('修复 CI')
    expect(screen.getByTestId('message-roles')).toHaveTextContent('user:修复 CI')
    expect(screen.getByTestId('message-goal-flags')).toHaveTextContent('goal:修复 CI')

    await userEvent.click(screen.getByText('start new chat'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
    )
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('goal-objective')).toHaveTextContent('none')
  })

  test('enters goal draft mode when setting a goal without input', async () => {
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({
        listRuntimeWork: vi.fn().mockResolvedValue(
          createRuntimeWork({
            projects: [
              {
                project: { id: 7, name: 'Wegent' },
                deviceWorkspaces: [
                  {
                    deviceId: 'device-1',
                    deviceName: 'Project Device',
                    deviceStatus: 'online',
                    workspacePath: '/workspace/project-alpha',
                    mapped: true,
                    available: true,
                    tasks: [],
                  },
                ],
              },
            ],
            totalTasks: 0,
          })
        ),
      }) as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('enable plan mode'))
    expect(screen.getByTestId('project-collaboration-mode')).toHaveTextContent('plan')
    await userEvent.click(screen.getByText('set goal'))

    expect(screen.getByTestId('goal-draft-active')).toHaveTextContent('active')
    expect(screen.getByTestId('project-collaboration-mode')).toHaveTextContent('default')
    expect(screen.getByTestId('workbench-error')).toHaveTextContent('')
    expect(screen.getByTestId('goal-objective')).toHaveTextContent('none')
  })

  test('reports a visible error when submitting an empty goal draft', async () => {
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({
        listRuntimeWork: vi.fn().mockResolvedValue(
          createRuntimeWork({
            projects: [
              {
                project: { id: 7, name: 'Wegent' },
                deviceWorkspaces: [
                  {
                    deviceId: 'device-1',
                    deviceName: 'Project Device',
                    deviceStatus: 'online',
                    workspacePath: '/workspace/project-alpha',
                    mapped: true,
                    available: true,
                    tasks: [],
                  },
                ],
              },
            ],
            totalTasks: 0,
          })
        ),
      }) as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set goal'))
    await userEvent.click(screen.getByText('send'))

    expect(screen.getByTestId('pane-session-error')).toHaveTextContent('请输入目标内容')
    expect(screen.getByTestId('workbench-error')).toHaveTextContent('')
  })

  test('shows waiting status while creating a new runtime task from a fresh message', async () => {
    const createResponse = deferred<{
      accepted: boolean
      deviceId: string
      taskId: string
      workspacePath: string
      runtime: string
    }>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn().mockReturnValue(createResponse.promise),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('pane-busy')).toHaveTextContent('busy')
    expect(screen.getByTestId('pane-waiting')).toHaveTextContent('waiting')

    await act(async () => {
      createResponse.resolve({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
      })
      await createResponse.promise
    })
  })

  test('keeps default model options when creating a runtime task', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'codex',
      })),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTranscriptRequest) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        runtime: 'codex',
        messages: [],
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('enable plan mode'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        modelOptions: { collaborationMode: 'plan' },
      })
    )
  })

  test('stores the selector model identity separately from its execution model id', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'codex',
      })),
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'cloud:user:shared-model',
              type: 'user',
              provider: 'cloud',
              config: {
                weworkExecution: {
                  source: 'cloud',
                  modelName: 'shared-model',
                  modelType: 'user',
                },
                weworkModelKind: 'model-interface',
                ui: { family: 'model-interface', controls: ['collaborationMode'] },
              },
              runtime: { family: 'openai.openai-responses' },
            },
          ],
        }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('enable plan mode'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'shared-model',
        modelType: 'user',
        modelSelection: {
          modelName: 'cloud:user:shared-model',
          modelType: 'user',
          options: { collaborationMode: 'plan', reasoning: 'high' },
        },
      })
    )
  })

  test('uses the latest default model options when plan mode and send happen together', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'codex',
      })),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTranscriptRequest) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        runtime: 'codex',
        messages: [],
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('enable plan and send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        modelOptions: { collaborationMode: 'plan' },
      })
    )
  })

  test('keeps the sent user message and new task visible when the resolved address adds a workspace path', async () => {
    const initialRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
      ],
      chats: [],
      totalTasks: 0,
    })
    const staleRuntimeWork = createRuntimeWork({
      projects: [],
      chats: [],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockResolvedValueOnce(initialRuntimeWork)
        .mockResolvedValue(staleRuntimeWork),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimePaneSendProbe />, services)

    await waitFor(() => expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1'))
    await userEvent.click(await screen.findByText('select mapped project workspace'))
    await userEvent.click(screen.getByText('set pane input'))
    await userEvent.click(screen.getByText('send pane input'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-created:/workspace/project-alpha'
      )
    )
    expect(screen.getByTestId('pane-message-roles')).toHaveTextContent('user:修复 CI')
    expect(screen.getByTestId('runtime-local-task-count')).toHaveTextContent('1')
    expect(screen.getByTestId('runtime-local-task-titles')).toHaveTextContent('修复 CI')
  })

  test('shows a goal-first pending goal in the newly opened runtime pane', async () => {
    const createRuntimeTask =
      deferred<
        Awaited<ReturnType<NonNullable<WorkbenchServices['runtimeWorkApi']>['createRuntimeTask']>>
      >()
    const initialRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
      ],
      chats: [],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(initialRuntimeWork),
      createRuntimeTask: vi.fn().mockReturnValue(createRuntimeTask.promise),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderStrictWorkbench(<RuntimePaneSendProbe />, services)

    await waitFor(() => expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1'))
    await userEvent.click(await screen.findByText('select mapped project workspace'))
    await userEvent.click(screen.getByText('set pane goal'))
    expect(screen.getByTestId('pane-goal-draft-active')).toHaveTextContent('active')
    await userEvent.click(screen.getByText('set pane input'))
    await userEvent.click(screen.getByText('send pane input'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('pane-goal-objective')).toHaveTextContent('修复 CI')

    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await act(async () => {
      createRuntimeTask.resolve({
        accepted: true,
        deviceId: 'device-1',
        taskId: request.taskId,
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      })
      await createRuntimeTask.promise
    })

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}:/workspace/project-alpha`
      )
    )
    expect(screen.getByTestId('pane-goal-objective')).toHaveTextContent('修复 CI')
  })

  test('keeps the optimistic first message when Strict Mode reloads an empty transcript', async () => {
    const initialRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
      ],
      chats: [],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(initialRuntimeWork),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderStrictWorkbench(<RuntimePaneSendProbe />, services)

    await waitFor(() => expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1'))
    await userEvent.click(await screen.findByText('select mapped project workspace'))
    await userEvent.click(screen.getByText('set pane input'))
    await userEvent.click(screen.getByText('send pane input'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-created:/workspace/project-alpha'
      )
    )
    expect(screen.getByTestId('pane-message-roles')).toHaveTextContent('user:修复 CI')
  })

  test('starts a fresh project pane after creating a runtime task in the same project', async () => {
    const initialRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
      ],
      chats: [],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(initialRuntimeWork),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimePaneSendProbe />, services)

    await waitFor(() => expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1'))
    await userEvent.click(await screen.findByText('select mapped project workspace'))
    await userEvent.click(screen.getByText('set pane input'))
    await userEvent.click(screen.getByText('send pane input'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-created:/workspace/project-alpha'
      )
    )
    expect(screen.getByTestId('pane-message-roles')).toHaveTextContent('user:修复 CI')

    const focusRequest = vi.fn()
    window.addEventListener('wework:focus-new-chat-composer', focusRequest, { once: true })
    await userEvent.click(screen.getByText('start new project task'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
    )
    await waitFor(() => expect(focusRequest).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('active-pane-key')).toHaveTextContent('project:7')
    expect(screen.getByTestId('pane-message-roles')).toHaveTextContent('')
    expect(screen.getByTestId('pane-goal-draft-active')).toHaveTextContent('inactive')
  })

  test('sends through the selected project immediately after the project pane commits', async () => {
    const initialRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
      ],
      chats: [],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(initialRuntimeWork),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        getHomeDirectory: vi.fn().mockRejectedValue(new Error('remote mkdir is unavailable')),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimePaneSendProbe />, services)

    await waitFor(() => expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1'))
    flushSync(() => screen.getByText('start new project task').click())
    flushSync(() => screen.getByText('set pane input').click())
    screen.getByText('send pane input').click()

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 7,
        deviceWorkspaceId: 22,
        message: '修复 CI',
      })
    )
    expect(services.deviceApi.getHomeDirectory).not.toHaveBeenCalled()
  })

  test('keeps streamed assistant content when the resolved address adds a workspace path', async () => {
    const streamHandlers: ChatStreamHandlers[] = []
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers.push(handlers)
      return vi.fn(() => {
        const index = streamHandlers.indexOf(handlers)
        if (index >= 0) streamHandlers.splice(index, 1)
      })
    })
    const createRuntimeTask =
      deferred<
        Awaited<ReturnType<NonNullable<WorkbenchServices['runtimeWorkApi']>['createRuntimeTask']>>
      >()
    const initialRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
      ],
      chats: [],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(initialRuntimeWork),
      createRuntimeTask: vi.fn().mockReturnValue(createRuntimeTask.promise),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimePaneSendProbe />, services)

    await waitFor(() => expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1'))
    await userEvent.click(await screen.findByText('select mapped project workspace'))
    await userEvent.click(screen.getByText('set pane input'))
    await userEvent.click(screen.getByText('send pane input'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await waitFor(() => expect(streamHandlers.some(handler => handler.onChatChunk)).toBe(true))
    await act(async () => {
      const startPayload = {
        taskId: request.taskId,
        subtaskId: '102',
        deviceId: 'device-1',
      }
      const chunkPayload = {
        taskId: request.taskId,
        subtaskId: '102',
        content: 'streamed answer',
        offset: 0,
        deviceId: 'device-1',
      }
      streamHandlers.forEach(handler => {
        handler.onChatStart?.(startPayload)
        handler.onChatChunk?.(chunkPayload)
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('pane-message-roles')).toHaveTextContent(
        'assistant:streamed answer'
      )
    )

    await act(async () => {
      createRuntimeTask.resolve({
        accepted: true,
        deviceId: 'device-1',
        taskId: request.taskId,
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      })
      await createRuntimeTask.promise
    })

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}:/workspace/project-alpha`
      )
    )
    expect(screen.getByTestId('pane-message-roles')).toHaveTextContent('user:修复 CI')
    expect(screen.getByTestId('pane-message-roles')).toHaveTextContent('assistant:streamed answer')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('opens the runtime route and shows thinking while runtime task creation is pending', async () => {
    const createRuntimeTask =
      deferred<
        Awaited<ReturnType<NonNullable<WorkbenchServices['runtimeWorkApi']>['createRuntimeTask']>>
      >()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn().mockReturnValue(createRuntimeTask.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    expect(request.taskId).toMatch(/^runtime-/)
    expect(parseRuntimeTaskRoute(window.location.pathname, window.location.search)).toEqual({
      deviceId: 'device-1',
      taskId: request.taskId,
    })
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      `device-1:${request.taskId}`
    )
    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent('正在思考')

    await act(async () => {
      createRuntimeTask.resolve({
        accepted: true,
        deviceId: 'device-1',
        taskId: request.taskId,
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      })
    })
    await waitFor(() => expect(screen.getByTestId('sending-state')).toHaveTextContent('idle'))
    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent('正在思考')
  })

  test('clears thinking when a created runtime task transcript is already complete', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: 'device-1',
        taskId: request.taskId,
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      })),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTaskAddress) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath ?? '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [
          {
            id: `${address.taskId}:user:1`,
            role: 'user',
            content: '修复 CI',
            status: 'done',
          },
          {
            id: `${address.taskId}:assistant:1`,
            role: 'assistant',
            content: 'done answer',
            status: 'done',
          },
        ],
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('message-roles')).toHaveTextContent('assistant'))
    expect(screen.getByTestId('message-roles')).toHaveTextContent('assistant:done answer')
    await waitFor(() => expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument())
  })

  test('renders image attachments immediately when creating a runtime task', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:runtime-message-image-preview')
    URL.revokeObjectURL = vi.fn()
    localStorage.setItem('auth_token', 'token-1')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
      })
    )
    const transcript = deferred<RuntimeTranscriptResponse>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'claude_code',
      })),
      getRuntimeTranscript: vi.fn().mockReturnValue(transcript.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('add image attachment'))
    expect(screen.getByTestId('project-attachment-count')).toHaveTextContent('1')
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('project-attachment-count')).toHaveTextContent('0')
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentIds: [45],
      })
    )
    const previews = await screen.findAllByTestId('message-image-preview')
    expect(
      previews.some(preview => preview.getAttribute('src') === 'blob:runtime-message-image-preview')
    ).toBe(true)
  })

  test('sends local image attachments as runtime attachments when creating a runtime task', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'claude_code',
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('add local image attachment'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    expect(request.attachmentIds).toEqual([])
    expect(request.attachments).toEqual([
      expect.objectContaining({
        id: -45,
        filename: 'photo.png',
        local_path: LOCAL_IMAGE_ATTACHMENT_PATH,
        local_preview_url: LOCAL_IMAGE_ATTACHMENT_PATH,
      }),
    ])
  })

  test('creates a runtime task from an explicitly opened standalone workspace', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork({ projects: [] })),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'standalone-created',
        workspacePath: '/workspace/direct-codex',
        runtime: 'codex',
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'standalone-created',
        workspacePath: '/workspace/direct-codex',
        runtime: 'codex',
        messages: [{ id: 'assistant-1', role: 'assistant', content: 'started' }],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('open standalone workspace')).toBeInTheDocument())
    await userEvent.click(screen.getByText('open standalone workspace'))
    await waitFor(() => expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/direct-codex',
      runtime: 'codex',
    })
    expect(`${window.location.pathname}${window.location.search}`).toBe('/')
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        workspacePath: '/workspace/direct-codex',
        teamId: 2,
        message: '修复 CI',
      })
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('projectId')
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty(
      'deviceWorkspaceId'
    )
  })

  test('creates a conversation workspace when sending without a selected project', async () => {
    vi.setSystemTime(new Date('2026-06-25T09:30:00.000Z'))
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork({ projects: [], chats: [] })),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'conversation-created',
        workspacePath: '/Users/alice/Documents/Codex/2026-06-25/ci',
        runtime: 'codex',
      }),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        getHomeDirectory: vi.fn().mockResolvedValue('/Users/alice'),
        createDirectory: vi.fn().mockResolvedValue(undefined),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('set input')).toBeInTheDocument())
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(services.deviceApi.getHomeDirectory).toHaveBeenCalledWith('device-1')
    const createdWorkspacePath = vi.mocked(services.deviceApi.createDirectory).mock.calls[0]?.[1]
    expect(createdWorkspacePath).toMatch(
      /^\/Users\/alice\/Documents\/Codex\/2026-06-25\/ci-[a-z0-9]{8}$/
    )
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        workspacePath: createdWorkspacePath,
        teamId: 2,
        message: '修复 CI',
      })
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('projectId')
    expect(screen.getByTestId('workbench-error')).not.toHaveTextContent(
      '请选择项目或打开设备工作区后再发送'
    )
  })

  test('registers a standalone Codex workspace with an optional label', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork({ projects: [] })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() =>
      expect(screen.getByText('open labeled standalone workspace')).toBeInTheDocument()
    )
    await userEvent.click(screen.getByText('open labeled standalone workspace'))
    await waitFor(() => expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/direct-codex',
      runtime: 'codex',
      label: 'Direct Codex',
    })
    await waitFor(() =>
      expect(screen.getByTestId('current-project-name')).toHaveTextContent('Direct Codex')
    )
    expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent(
      '/workspace/direct-codex'
    )
    expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(1)
  })

  test('resolves the local-device CLI alias to the real local executor device', async () => {
    const localDevice = createDevice({
      device_id: 'device-real-local',
      name: 'This Mac',
      device_type: 'local',
      status: 'online',
      is_default: true,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork({ projects: [] })),
      openRuntimeWorkspace: vi.fn().mockResolvedValue({
        accepted: true,
        workspacePath: '/workspace/cli-codex',
        runtime: 'codex',
      }),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-real-local',
        taskId: 'cli-created',
        workspacePath: '/workspace/cli-codex',
        runtime: 'codex',
      }),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([localDevice]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() =>
      expect(screen.getByText('open cli local-device workspace')).toBeInTheDocument()
    )
    await userEvent.click(screen.getByText('open cli local-device workspace'))

    await waitFor(() => expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: '/workspace/cli-codex',
      runtime: 'codex',
      label: 'CLI Project',
    })
    await waitFor(() =>
      expect(screen.getByTestId('current-project-name')).toHaveTextContent('CLI Project')
    )
    expect(screen.getByTestId('standalone-device-id')).toHaveTextContent('device-real-local')
    expect(screen.getByTestId('current-project-device-id')).toHaveTextContent('device-real-local')
    expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent(
      '/workspace/cli-codex'
    )

    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-real-local',
        workspacePath: '/workspace/cli-codex',
        message: '修复 CI',
      })
    )
  })

  test('opens a standalone runtime project first without refreshing the runtime list', async () => {
    const existingProject = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Existing Project' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
      ],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(existingProject),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-project-order')).toHaveTextContent('Existing Project')
    )
    await userEvent.click(screen.getByText('open labeled standalone workspace'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-project-order')).toHaveTextContent(
        'Direct Codex|Existing Project'
      )
    )
    expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(1)
  })

  test('removes a standalone workspace through the local runtime when its list is stale', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork()),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(screen.getByText('open standalone workspace'))
    await waitFor(() =>
      expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent(
        '/workspace/direct-codex'
      )
    )
    await userEvent.click(screen.getByText('remove standalone workspace'))

    await waitFor(() => expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      projectKey: '/workspace/direct-codex',
      workspacePath: '/workspace/direct-codex',
      runtime: 'codex',
    })
    expect(services.projectApi.deleteProject).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent('none')
    )
  })

  test('creates a device workspace project first without refreshing the runtime list', async () => {
    const createdProject = createProject({
      id: 88,
      name: 'New Runtime Project',
      config: { mode: 'workspace' },
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork()),
      prepareDeviceWorkspace: vi.fn().mockResolvedValue({
        preparedAction: 'selected',
        mapping: {
          id: 44,
          projectId: 88,
          deviceId: 'device-1',
          workspacePath: '/workspace/new-runtime-project',
          label: 'workspace',
        },
      }),
    })
    const services = createWorkbenchServices({
      projectApi: {
        createProject: vi.fn().mockResolvedValue(createdProject),
      } as Partial<WorkbenchServices['projectApi']> as WorkbenchServices['projectApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await waitFor(() => expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByText('create runtime project'))
    await waitFor(() => expect(runtimeWorkApi.prepareDeviceWorkspace).toHaveBeenCalledTimes(1))

    expect(services.projectApi.createProject).toHaveBeenCalledWith({
      name: 'New Runtime Project',
      description: '',
      config: { mode: 'workspace' },
    })
    expect(runtimeWorkApi.prepareDeviceWorkspace).toHaveBeenCalledWith({
      projectId: 88,
      deviceId: 'device-1',
      workspacePath: '/workspace/new-runtime-project',
      action: 'select',
    })
    expect(screen.getByTestId('mutation-project-name')).toHaveTextContent('New Runtime Project')
    expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(
      'New Runtime Project|Wegent'
    )
    expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(1)
  })

  test('renames and removes runtime projects through runtime-work metadata APIs', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock()
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await waitFor(() => expect(screen.getByText('rename runtime project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('rename runtime project'))
    await waitFor(() => expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      name: 'Hello project',
    })
    expect(services.projectApi.updateProject).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('remove runtime project'))
    await waitFor(() => expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
    })
    expect(services.projectApi.deleteProject).not.toHaveBeenCalled()
  })

  test('renames and removes unavailable runtime projects through runtime-work metadata APIs', async () => {
    const unavailableRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'offline',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: false,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
      ],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(unavailableRuntimeWork),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await waitFor(() => expect(screen.getByText('rename runtime project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('rename runtime project'))
    await waitFor(() => expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      name: 'Hello project',
    })
    expect(services.projectApi.updateProject).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('remove runtime project'))
    await waitFor(() => expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
    })
    expect(services.projectApi.deleteProject).not.toHaveBeenCalled()
  })

  test('renames and removes remote projects from both the remote executor and local Codex index', async () => {
    const remoteRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: {
            id: 7,
            key: '/srv/project-alpha',
            sidebarStateKey: 'remote-project-id',
            name: 'Wegent',
            kind: 'remote',
            source: 'remote_project',
            stateDeviceId: 'local-device',
          },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'remote-device',
              remoteHostId: 'remote-device',
              deviceName: 'Remote Device',
              deviceStatus: 'online',
              workspacePath: '/srv/project-alpha',
              workspaceSource: 'remote',
              mapped: true,
              available: true,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
      ],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(remoteRuntimeWork),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi
          .fn()
          .mockResolvedValue([
            createDevice({ device_id: 'local-device', device_type: 'local' }),
            createDevice({ device_id: 'remote-device', device_type: 'remote', is_default: false }),
          ]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi
          .fn()
          .mockResolvedValue([
            createDevice({ device_id: 'remote-device', device_type: 'remote', is_default: false }),
          ]),
        listRuntimeWork: vi.fn().mockResolvedValue({
          projects: [],
          chats: [],
          totalTasks: 0,
        }),
      },
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await userEvent.click(await screen.findByText('rename runtime project'))
    await waitFor(() => expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenCalledTimes(2))
    expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenNthCalledWith(1, {
      deviceId: 'remote-device',
      projectKey: '/srv/project-alpha',
      workspacePath: '/srv/project-alpha',
      runtime: 'codex',
      name: 'Hello project',
    })
    expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenNthCalledWith(2, {
      deviceId: 'local-device',
      projectKey: 'remote-project-id',
      workspacePath: '/srv/project-alpha',
      runtime: 'codex',
      name: 'Hello project',
    })

    await userEvent.click(screen.getByText('remove runtime project'))
    await waitFor(() => expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledTimes(2))
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenNthCalledWith(1, {
      deviceId: 'remote-device',
      projectKey: '/srv/project-alpha',
      workspacePath: '/srv/project-alpha',
      runtime: 'codex',
    })
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenNthCalledWith(2, {
      deviceId: 'local-device',
      projectKey: 'remote-project-id',
      workspacePath: '/srv/project-alpha',
      runtime: 'codex',
    })
  })

  test('archives a worktree task without prompting and preserves a snapshot', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 92,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/worktrees/9/project-alpha',
                  workspaceKind: 'worktree',
                  worktreeId: '9',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-worktree',
                      workspacePath: '/workspace/worktrees/9/project-alpha',
                      workspaceKind: 'worktree',
                      worktreeId: '9',
                      title: 'Worktree task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
          ],
          totalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ArchiveRuntimeTaskProbe />, services)

    await waitFor(() => expect(screen.getByText('archive worktree task')).toBeInTheDocument())
    await userEvent.click(screen.getByText('archive worktree task'))

    await waitFor(() => expect(screen.getByTestId('archive-result')).toHaveTextContent('archived'))
    expect(screen.getByTestId('workbench-error')).toHaveTextContent('')
    expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1)
    expect(runtimeWorkApi.deleteWorktree).toHaveBeenCalledWith({
      deviceId: 'device-1',
      path: '/workspace/worktrees/9/project-alpha',
      preserveSnapshot: true,
    })
  })

  test('keeps a newly opened task selected when a different task finishes archiving', async () => {
    const archiveRequest = deferred<{
      accepted: boolean
      taskId: string
      workspacePath: string
      runtime: 'codex'
    }>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork()),
      archiveConversation: vi.fn().mockReturnValue(archiveRequest.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ArchiveRuntimeTaskProbe />, services)

    await waitFor(() => expect(screen.getByText('archive worktree task')).toBeInTheDocument())
    await userEvent.click(screen.getByText('archive worktree task'))
    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByText('open runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task')).toHaveTextContent('runtime-b')
    )

    archiveRequest.resolve({
      accepted: true,
      taskId: 'runtime-worktree',
      workspacePath: '/workspace/worktrees/9/project-alpha',
      runtime: 'codex',
    })

    await waitFor(() => expect(screen.getByTestId('archive-result')).toHaveTextContent('archived'))
    expect(screen.getByTestId('current-runtime-task')).toHaveTextContent('runtime-b')
  })

  test('force archive also uses the snapshot-capable worktree API', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 92,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/worktrees/9/project-alpha',
                  workspaceKind: 'worktree',
                  worktreeId: '9',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-worktree',
                      workspacePath: '/workspace/worktrees/9/project-alpha',
                      workspaceKind: 'worktree',
                      worktreeId: '9',
                      title: 'Worktree task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
          ],
          totalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ArchiveRuntimeTaskProbe />, services)

    await waitFor(() => expect(screen.getByText('force archive worktree task')).toBeInTheDocument())
    await userEvent.click(screen.getByText('force archive worktree task'))

    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.deleteWorktree).toHaveBeenCalledWith({
      deviceId: 'device-1',
      path: '/workspace/worktrees/9/project-alpha',
      preserveSnapshot: true,
    })
    await waitFor(() => expect(screen.getByTestId('archive-result')).toHaveTextContent('archived'))
  })

  test('archives a task before snapshotting and removing its worktree', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 92,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/worktrees/9/project-alpha',
                  workspaceKind: 'worktree',
                  worktreeId: '9',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-worktree',
                      workspacePath: '/workspace/worktrees/9/project-alpha',
                      workspaceKind: 'worktree',
                      worktreeId: '9',
                      title: 'Worktree task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
          ],
          totalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ArchiveRuntimeTaskProbe />, services)

    await waitFor(() => expect(screen.getByText('archive worktree task')).toBeInTheDocument())
    await userEvent.click(screen.getByText('archive worktree task'))

    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(runtimeWorkApi.deleteWorktree).toHaveBeenCalledWith({
        deviceId: 'device-1',
        path: '/workspace/worktrees/9/project-alpha',
        preserveSnapshot: true,
      })
    )
    const removeCallOrder = runtimeWorkApi.deleteWorktree.mock.invocationCallOrder.at(-1)
    expect(runtimeWorkApi.archiveConversation.mock.invocationCallOrder[0]).toBeLessThan(
      removeCallOrder ?? 0
    )
  })

  test('archives project conversations without a dirty-worktree prompt', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, key: 'project:7', name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 92,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/worktrees/9/project-alpha',
                  workspaceKind: 'worktree',
                  worktreeId: '9',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-worktree',
                      workspacePath: '/workspace/worktrees/9/project-alpha',
                      workspaceKind: 'worktree',
                      worktreeId: '9',
                      title: 'Worktree task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
            {
              project: { key: 'remote-project-key', name: 'Remote project' },
              deviceWorkspaces: [
                {
                  deviceId: 'remote-device',
                  deviceName: 'Remote device',
                  deviceStatus: 'online',
                  workspacePath: '/srv/remote-project',
                  available: true,
                  tasks: [
                    {
                      taskId: 'remote-project-task',
                      workspacePath: '/srv/remote-project',
                      title: 'Remote project task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
          ],
          totalTasks: 2,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ArchiveProjectConversationsProbe />, services)

    await waitFor(() =>
      expect(screen.getByText('archive project conversations')).toBeInTheDocument()
    )
    await userEvent.click(screen.getByText('archive project conversations'))

    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(2))
    expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/worktrees/9/project-alpha',
      taskId: 'runtime-worktree',
    })
    expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledWith({
      deviceId: 'remote-device',
      workspacePath: '/srv/remote-project',
      taskId: 'remote-project-task',
    })
    expect(runtimeWorkApi.archiveProjectConversations).not.toHaveBeenCalled()
    expect(runtimeWorkApi.deleteWorktree).toHaveBeenCalledWith({
      deviceId: 'device-1',
      path: '/workspace/worktrees/9/project-alpha',
      preserveSnapshot: true,
    })
    await waitFor(() => expect(screen.getByTestId('archive-result')).toHaveTextContent('archived'))
  })

  test('does not restore an archived remote task from the previous cloud snapshot', async () => {
    const remoteRuntimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: 'remote-project', name: 'Remote Wegent' },
          deviceWorkspaces: [
            {
              deviceId: 'remote-device',
              deviceName: '10.201.3.200',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/srv/Wegent',
              workspaceSource: 'remote',
              remoteHostId: 'remote-device',
              tasks: [
                {
                  taskId: 'remote-task',
                  workspacePath: '/srv/Wegent',
                  title: 'Remote task',
                  runtime: 'codex',
                },
              ],
            },
          ],
          totalTasks: 1,
        },
      ],
      chats: [],
      totalTasks: 1,
    }
    const postArchiveCloudWork = deferred<RuntimeWorkListResponse>()
    const cloudListRuntimeWork = vi
      .fn()
      .mockResolvedValueOnce(remoteRuntimeWork)
      .mockReturnValue(postArchiveCloudWork.promise)
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue({ projects: [], chats: [], totalTasks: 0 }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([
          createDevice({
            id: 2,
            device_id: 'remote-device',
            name: '10.201.3.200',
            status: 'online',
            is_default: false,
            device_type: 'remote',
          }),
        ]),
        listRuntimeWork: cloudListRuntimeWork,
      },
    })

    renderWorkbench(<ArchiveRemoteRuntimeTaskProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('archive-remote-task-titles')).toHaveTextContent('Remote task')
    )
    await userEvent.click(screen.getByText('archive remote task'))

    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(cloudListRuntimeWork).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('archive-remote-task-titles')).toHaveTextContent('')

    postArchiveCloudWork.resolve({ projects: [], chats: [], totalTasks: 0 })
    await waitFor(() =>
      expect(screen.getByTestId('archive-remote-task-titles')).toHaveTextContent('')
    )
  })

  test('renders streaming runtime task chunks when the socket connects after chat start', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const transcript = deferred<RuntimeTranscriptResponse>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'codex',
      })),
      getRuntimeTranscript: vi.fn().mockReturnValue(transcript.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}`
      )
    )
    await waitFor(() => expect(streamHandlers.onChatChunk).toBeDefined())

    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: request.taskId,
        subtaskId: '102',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
      streamHandlers.onChatChunk?.({
        taskId: request.taskId,
        subtaskId: '102',
        content: 'streamed answer',
        offset: 0,
        deviceId: 'device-1',
      })
    })

    expect(screen.getByTestId('message-roles')).toHaveTextContent('user:修复 CI')
    expect(screen.getByTestId('message-roles')).not.toHaveTextContent('assistant:streamed answer')

    await act(async () => {
      transcript.resolve({
        taskId: request.taskId,
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [
          { id: 'user-1', role: 'user', content: '修复 CI' },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'streamed answer',
            subtaskId: '102',
          },
        ],
      })
      await transcript.promise
    })

    await waitFor(() =>
      expect(screen.getByTestId('message-roles')).toHaveTextContent('assistant:streamed answer')
    )
  })

  test('restores a runtime task from the URL with transcript blocks', async () => {
    window.history.pushState({}, '', '/runtime-tasks?deviceId=device-1&taskId=runtime-restored')
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        { id: 'user-1', role: 'user', content: '恢复的问题' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '恢复的回答',
          subtaskId: 901,
          fileChanges: {
            version: 1,
            status: 'active',
            artifact_id: 'turn-901',
            device_id: 'device-1',
            workspace_path: '/workspace/project-alpha',
            file_count: 1,
            additions: 4,
            deletions: 2,
            files: [
              {
                path: 'src/runtime.ts',
                change_type: 'modified',
                additions: 4,
                deletions: 2,
                binary: false,
              },
            ],
            reverted_at: null,
          },
          blocks: [
            {
              id: 'thinking-901',
              type: 'thinking',
              content: '读取历史记录',
              status: 'done',
              timestamp: 1770000000,
            },
            {
              id: 'call-901',
              type: 'tool',
              tool_name: 'exec_command',
              tool_input: { cmd: 'pwd' },
              tool_output: '/workspace/project-alpha',
              status: 'done',
              timestamp: 1770000001000,
            },
            {
              id: 'text-901',
              type: 'text',
              content: '处理完成',
              status: 'done',
              timestamp: 1770000002000,
            },
          ],
        },
      ],
    } satisfies RuntimeTranscriptResponse)
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-restored'
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('恢复的问题')
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
      'thinking:读取历史记录:done'
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent('tool:exec_command:done')
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent('text:处理完成:done')
    expect(screen.getByTestId('runtime-open-file-changes')).toHaveTextContent('src/runtime.ts')
    expect(getRuntimeTranscript).toHaveBeenCalledWith({
      deviceId: 'device-1',
      taskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      limit: 50,
    })
  })

  test('retries a live failure with the submitted prompt when the failed subtask is reused', async () => {
    window.history.pushState({}, '', '/runtime-tasks?deviceId=device-1&taskId=runtime-restored')
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-restored',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-restored',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [
          {
            id: 'user-old',
            role: 'user',
            content: '旧问题',
            status: 'done',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'assistant-old',
            role: 'assistant',
            content: '旧回答',
            status: 'done',
            subtaskId: 'reused-subtask',
            createdAt: '2026-01-01T00:00:01.000Z',
          },
        ],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: { subscribe } as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-restored'
      )
    )
    await waitFor(() => expect(screen.getByTestId('message-roles')).toHaveTextContent('旧回答'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))

    await act(async () => {
      streamHandlers.onChatError?.({
        taskId: 'runtime-restored',
        subtaskId: 'reused-subtask',
        deviceId: 'device-1',
        error: 'codex app-server exited',
      })
    })
    await userEvent.click(await screen.findByTestId('assistant-error-retry'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(2))
    expect(sendRuntimeMessage.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        address: expect.objectContaining({ taskId: 'runtime-restored' }),
        message: '修复 CI',
      })
    )
  })

  test('uses runtime transcript server times for blocks without timestamps', async () => {
    vi.setSystemTime(new Date('2026-06-05T00:01:00.000Z'))
    window.history.pushState({}, '', '/runtime-tasks?deviceId=device-1&taskId=runtime-restored')
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '恢复的回答',
          subtaskId: '901',
          createdAt: '2026-06-05T00:00:00.000Z',
          blocks: [
            {
              id: 'thinking-901',
              type: 'thinking',
              content: '读取历史记录',
              status: 'done',
              created_at: '2026-06-05T00:00:06.000Z',
            },
            {
              id: 'text-901',
              type: 'text',
              content: '处理完成',
              status: 'done',
            },
          ],
        },
      ],
    } satisfies RuntimeTranscriptResponse)
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-block-times')).toHaveTextContent(
        '1780617606000|1780617600000'
      )
    )
  })

  test('restores runtime transcript file changes onto assistant messages', async () => {
    window.history.pushState({}, '', '/runtime-tasks?deviceId=device-1&taskId=runtime-restored')
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        { id: 'user-1', role: 'user', content: '修复搜索' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '已修复',
          subtaskId: '902',
          fileChanges: createTurnFileChanges(),
        },
      ],
    } satisfies RuntimeTranscriptResponse)
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-file-changes')).toHaveTextContent('1:6:4')
    )
  })

  test('restores a runtime task from the URL even when it is missing from the work list', async () => {
    window.history.pushState({}, '', '/runtime-tasks?deviceId=device-1&taskId=codex-hidden')
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'codex-hidden',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        { id: 'user-hidden', role: 'user', content: 'hidden user message' },
        { id: 'assistant-hidden', role: 'assistant', content: 'hidden assistant message' },
      ],
    } satisfies RuntimeTranscriptResponse)
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [],
          chats: [],
          totalTasks: 0,
        })
      ),
      getRuntimeTranscript,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:codex-hidden'
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent(
        'hidden user message|hidden assistant message'
      )
    )
    expect(getRuntimeTranscript).toHaveBeenCalledWith({
      deviceId: 'device-1',
      taskId: 'codex-hidden',
      limit: 50,
    })
  })

  test('loads older runtime transcript messages before the current page', async () => {
    const getRuntimeTranscript = vi.fn(request => {
      if (request.beforeCursor === 'offset:120') {
        return Promise.resolve({
          taskId: 'runtime-a',
          workspacePath: '/workspace/project-alpha',
          runtime: 'codex',
          messages: [{ id: 'runtime-a:user:o20', role: 'user', content: 'older message' }],
          hasMoreBefore: false,
          beforeCursor: null,
        } satisfies RuntimeTranscriptResponse)
      }
      return Promise.resolve({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-a:user:o120', role: 'user', content: 'recent message' }],
        hasMoreBefore: true,
        beforeCursor: 'offset:120',
      } satisfies RuntimeTranscriptResponse)
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('recent message')
    )
    expect(screen.getByTestId('runtime-transcript-has-more')).toHaveTextContent('more')

    await userEvent.click(screen.getByText('load older'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent(
        'older message|recent message'
      )
    )
    expect(getRuntimeTranscript).toHaveBeenLastCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      taskId: 'runtime-a',
      limit: 50,
      beforeCursor: 'offset:120',
    })
    expect(screen.getByTestId('runtime-transcript-has-more')).toHaveTextContent('done')
  })

  test('reloads the selected runtime transcript when switching back to a task', async () => {
    const getRuntimeTranscript = vi.fn((request: RuntimeTranscriptRequest) => {
      if (request.taskId === 'runtime-a') {
        return Promise.resolve({
          taskId: 'runtime-a',
          workspacePath: '/workspace/project-alpha',
          runtime: 'codex',
          messages: [
            { id: 'runtime-a:user:1', role: 'user', content: 'first a' },
            { id: 'runtime-a:assistant:1', role: 'assistant', content: 'answer a' },
          ],
          hasMoreBefore: false,
          beforeCursor: null,
        } satisfies RuntimeTranscriptResponse)
      }
      return Promise.resolve({
        taskId: 'runtime-b',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-b:user:1', role: 'user', content: 'message b' }],
        hasMoreBefore: false,
        beforeCursor: null,
      } satisfies RuntimeTranscriptResponse)
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first a|answer a')
    )

    await userEvent.click(screen.getByText('open runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message b')
    )
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(2)

    await userEvent.click(screen.getByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first a|answer a')
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(3))
    expect(getRuntimeTranscript).toHaveBeenLastCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      taskId: 'runtime-a',
      limit: 50,
    })
  })

  test('does not immediately reload a runtime transcript after the initial open', async () => {
    const runningWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'codex',
                  running: true,
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    const getRuntimeTranscript = vi.fn().mockImplementation(async () => {
      return {
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [
          { id: 'user-1', role: 'user', content: 'first message' },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
            subtaskId: '901',
          },
        ],
      } satisfies RuntimeTranscriptResponse
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(runningWork),
      getRuntimeTranscript,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message|working')
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)
  })

  test('reviews runtime transcript file changes through device command and reverts through runtime API', async () => {
    window.history.pushState({}, '', '/runtime-tasks?deviceId=device-1&taskId=runtime-restored')
    const fileChanges = createTurnFileChanges()
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        { id: 'user-1', role: 'user', content: '修复搜索' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '已修复',
          subtaskId: '902',
          fileChanges,
        },
      ],
    } satisfies RuntimeTranscriptResponse)
    const executeCommand = vi.fn().mockResolvedValueOnce({
      success: true,
      stdout: { success: true, diff: 'diff --git a/file b/file' },
      stderr: '',
    })
    const revertRuntimeFileChanges = vi.fn().mockResolvedValue({
      fileChanges: {
        ...fileChanges,
        status: 'reverted',
        reverted_at: '2026-06-05T00:00:00.000Z',
      },
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({
        getRuntimeTranscript,
        revertRuntimeFileChanges,
      }) as WorkbenchServices['runtimeWorkApi'],
      deviceApi: {
        executeCommand,
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-file-changes')).toHaveTextContent('1:6:4')
    )
    await userEvent.click(screen.getByText('review runtime file changes'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-file-changes-diff')).toHaveTextContent(
        'diff --git a/file b/file'
      )
    )
    expect(executeCommand).toHaveBeenCalledWith('device-1', {
      command_key: 'turn_file_changes_review',
      path: fileChanges.workspace_path,
      args: [fileChanges.artifact_id],
      timeout_seconds: 30,
      max_output_bytes: 5 * 1024 * 1024,
    })

    await userEvent.click(screen.getByText('revert runtime file changes'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-file-changes-status')).toHaveTextContent('reverted')
    )
    expect(revertRuntimeFileChanges).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        taskId: 'runtime-restored',
        workspacePath: '/workspace/project-alpha',
      },
      fileChanges: expect.objectContaining(fileChanges),
    })
    expect(screen.getByTestId('runtime-open-file-changes')).toHaveTextContent('1:6:4')
  })

  test('reviews runtime file changes from the provided summary when messages are stale', async () => {
    window.history.pushState({}, '', '/runtime-tasks?deviceId=device-1&taskId=runtime-restored')
    const fileChanges = createTurnFileChanges()
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        { id: 'user-1', role: 'user', content: '修复搜索' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '已修复',
          subtaskId: '902',
          fileChanges,
        },
      ],
    } satisfies RuntimeTranscriptResponse)
    const executeCommand = vi.fn().mockResolvedValueOnce({
      success: true,
      stdout: { success: true, diff: 'diff --git a/stale b/stale' },
      stderr: '',
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({
        getRuntimeTranscript,
      }) as WorkbenchServices['runtimeWorkApi'],
      deviceApi: {
        executeCommand,
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-file-changes')).toHaveTextContent('1:6:4')
    )
    await userEvent.click(screen.getByText('review runtime file changes from stale messages'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-file-changes-diff')).toHaveTextContent(
        'diff --git a/stale b/stale'
      )
    )

    expect(executeCommand).toHaveBeenCalledWith('device-1', {
      command_key: 'turn_file_changes_review',
      path: fileChanges.workspace_path,
      args: [fileChanges.artifact_id],
      timeout_seconds: 30,
      max_output_bytes: 5 * 1024 * 1024,
    })
  })

  test('switches the selected runtime task before transcript loading finishes', async () => {
    const firstTranscript = deferred<RuntimeTranscriptResponse>()
    const getRuntimeTranscript = vi.fn((address: RuntimeTaskAddress) => {
      if (address.taskId === 'runtime-a') return firstTranscript.promise
      return Promise.resolve({
        taskId: 'runtime-b',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-b:user:1', role: 'user', content: 'message b' }],
      } satisfies RuntimeTranscriptResponse)
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      'device-1:runtime-a'
    )
    expect(screen.getByTestId('runtime-transcript-loading')).toHaveTextContent('loading')
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('')

    await userEvent.click(screen.getByText('open runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-b'
      )
    )
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message b')
    expect(screen.getByTestId('runtime-transcript-loading')).toHaveTextContent('idle')

    await act(async () => {
      firstTranscript.resolve({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'message a' }],
      })
      await firstTranscript.promise
    })

    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      'device-1:runtime-b'
    )
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message b')
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('message a')
  })

  test('does not reload the currently selected runtime task when clicked again', async () => {
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'runtime-a',
      workspacePath: '/workspace/project-alpha',
      runtime: 'claude_code',
      messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'message a' }],
    } satisfies RuntimeTranscriptResponse)
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message a')
    )
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByText('open runtime a'))

    expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message a')
    expect(screen.getByTestId('runtime-transcript-loading')).toHaveTextContent('idle')
  })

  test('keeps the runtime stream subscription when the same task address is rebuilt', async () => {
    const runtimeCleanup = vi.fn()
    const subscribe = vi.fn((handlers: ChatStreamHandlers) =>
      handlers.scope?.taskId === 'runtime-a' ? runtimeCleanup : vi.fn()
    )
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'message a' }],
      } satisfies RuntimeTranscriptResponse),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    render(
      <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
        <RuntimePaneSessionIdentityProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('runtime-session-messages')).toHaveTextContent('message a')
    )
    const runtimeSubscribeCount = () =>
      subscribe.mock.calls.filter(([handlers]) => handlers.scope?.taskId === 'runtime-a').length
    await waitFor(() => expect(runtimeSubscribeCount()).toBe(1))

    await userEvent.click(screen.getByText('rebuild same runtime address'))

    expect(runtimeSubscribeCount()).toBe(1)
    expect(runtimeCleanup).not.toHaveBeenCalled()
  })

  test('clears the task plan progress when starting a new chat', async () => {
    renderWorkbench(<RuntimePlanScopeProbe />)

    await userEvent.click(await screen.findByText('open runtime plan scope'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-plan-scope-task')).toHaveTextContent('runtime-plan-scope')
    )

    await act(async () => {
      emitResponseApiEvent(
        {},
        'runtime.plan.updated',
        {
          taskId: 'runtime-plan-scope',
          deviceId: 'device-1',
          data: {
            plan: [{ step: 'Implement the fix', status: 'inProgress' }],
          },
        },
        createResponseApiStreamState()
      )
      globalThis.dispatchEvent(new Event('wework-runtime-plan-updated'))
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-plan-progress-button')).toBeInTheDocument()
    )

    await userEvent.click(screen.getByText('start new plan scope chat'))

    await waitFor(() => {
      expect(screen.getByTestId('runtime-plan-scope-task')).toHaveTextContent('none')
      expect(screen.queryByTestId('runtime-plan-progress-button')).not.toBeInTheDocument()
    })
  })

  test('reuses the current runtime task address for follow-up messages', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
    })
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('继续修')
  })

  test('marks an existing runtime task running while a follow-up send is pending', async () => {
    const sendResponse = deferred<{ accepted: boolean; taskId: string }>()
    const sendRuntimeMessage = vi.fn().mockReturnValue(sendResponse.promise)
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('idle')

    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('running')

    await act(async () => {
      sendResponse.resolve({ accepted: true, taskId: 'runtime-a' })
      await sendResponse.promise
    })
  })

  test('keeps project chat composer state scoped to each runtime pane', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockImplementation(({ taskId }) =>
        Promise.resolve({
          taskId,
          workspacePath: '/workspace/project-alpha',
          runtime: 'claude_code',
          messages: [{ id: `${taskId}:user:1`, role: 'user', content: `message ${taskId}` }],
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<FollowUpProbe />, services)

    await userEvent.click(await screen.findByText('open follow-up runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-collaboration-mode')).toHaveTextContent('default')
    )
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('0')

    await userEvent.click(screen.getByText('enable follow-up plan mode'))
    await userEvent.click(screen.getByText('add image attachment'))
    expect(screen.getByTestId('follow-up-collaboration-mode')).toHaveTextContent('plan')
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('1')

    await userEvent.click(screen.getByText('open follow-up runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-collaboration-mode')).toHaveTextContent('default')
    )
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('0')

    await userEvent.click(screen.getByText('open follow-up runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-collaboration-mode')).toHaveTextContent('plan')
    )
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('1')
  })

  test('keeps blank chat draft when using sidebar new chat from a runtime task', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'runtime-a',
      workspacePath: '/workspace/project-alpha',
      runtime: 'claude_code',
      messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'message runtime-a' }],
    })
    const runtimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'claude_code',
                  running: true,
                },
              ],
            },
          ],
          totalTasks: 1,
        },
      ],
      totalTasks: 1,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(runtimeWork),
      getRuntimeTranscript,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<FollowUpProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('follow-up-collaboration-mode')).toHaveTextContent('default')
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('add image attachment'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('1')

    await userEvent.click(screen.getByText('open follow-up runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('0')
    )
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('follow-up-messages')).toHaveTextContent('user:message runtime-a')

    await userEvent.click(screen.getByText('sidebar new follow-up chat'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-current-runtime-task')).toHaveTextContent('none')
    )
    expect(screen.getByTestId('composer-input')).toHaveTextContent('继续修')
    expect(screen.getByTestId('follow-up-messages')).toHaveTextContent('user:message runtime-a')
    await waitFor(() =>
      expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('1')
    )

    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        offset: 0,
        content: 'retained stream output',
        deviceId: 'device-1',
      })
    })

    expect(screen.getByTestId('follow-up-current-runtime-task')).toHaveTextContent('none')
    expect(screen.getByTestId('follow-up-pane-busy')).toHaveTextContent('busy')
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-messages')).toHaveTextContent('retained stream output')
    )

    await userEvent.click(screen.getByText('open follow-up runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-current-runtime-task')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('follow-up-messages')).toHaveTextContent('user:message runtime-a')
  })

  test('keeps blank chat draft when selecting a project chat context', async () => {
    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('add image attachment'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('修复 CI')
    expect(screen.getByTestId('project-attachment-count')).toHaveTextContent('1')
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('none')

    await userEvent.click(screen.getByText('select project'))

    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('composer-input')).toHaveTextContent('修复 CI')
    expect(screen.getByTestId('project-attachment-count')).toHaveTextContent('1')
  })

  test('starts standalone chat with a fresh blank draft scope', async () => {
    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() => expect(screen.getByText('start standalone chat')).toBeInTheDocument())
    await userEvent.click(screen.getByText('set input'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('修复 CI')
    expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent('0')

    await userEvent.click(screen.getByText('start standalone chat'))

    await waitFor(() => expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent('1'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('')
  })

  test('hydrates queued plugin trial input into a fresh standalone chat', async () => {
    sessionStorage.setItem(
      'wework:pending-plugin-trial',
      JSON.stringify({
        input: '[$Documents](plugin://documents@OpenAI Bundled) ',
        pluginName: 'Documents',
      })
    )

    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() => expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent('1'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('Documents')
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test('sends a follow-up message after setting a goal in an existing runtime task', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const setRuntimeGoal = vi.fn().mockImplementation(request =>
      Promise.resolve({
        accepted: true,
        goal: createRuntimeGoal({
          objective: request.objective ?? '现有目标',
          status: request.status ?? 'active',
        }),
      })
    )
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
      setRuntimeGoal,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('set follow-up goal'))
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(setRuntimeGoal).toHaveBeenCalledTimes(1))
    expect(setRuntimeGoal).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      objective: '继续修',
      status: 'active',
    })
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
    })
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-goal-flags')).toHaveTextContent('goal:继续修')
  })

  test('sends the currently selected model with runtime follow-up messages', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'codex-gpt-5.5',
        type: 'runtime',
        modelId: 'gpt-5.5',
        runtime: { family: 'openai.openai-responses' },
      },
      {
        name: 'gpt-5-2025-08-07',
        type: 'public',
        displayName: '海外:gpt-5-2025-08-07',
        provider: 'openai',
        runtime: { family: 'openai', provider: 'openai' },
      },
    ]
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-model-statuses')).toHaveTextContent(
        'gpt-5-2025-08-07:enabled'
      )
    )
    await userEvent.click(screen.getByText('select gpt model'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-selected-model')).toHaveTextContent('gpt-5-2025-08-07')
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '继续修',
        modelId: 'gpt-5-2025-08-07',
        modelType: 'public',
      })
    )
  })

  test('sends default model options with runtime follow-up messages', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: [] }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('enable follow-up plan mode'))
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '继续修',
        modelOptions: { collaborationMode: 'plan' },
      })
    )
  })

  test('sends default collaboration mode when follow-up plan mode is disabled', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: [] }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('enable follow-up plan mode'))
    await userEvent.click(screen.getByText('disable follow-up plan mode'))
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '继续修',
        modelOptions: { collaborationMode: 'default' },
      })
    )
  })

  test('sends runtime model fields with implementation plan confirmations', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-a:assistant:1', role: 'assistant', content: 'plan' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: [] }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('plan')
    )
    await userEvent.click(screen.getByText('enable follow-up plan mode'))
    expect(screen.getByTestId('follow-up-collaboration-mode')).toHaveTextContent('plan')
    await userEvent.click(screen.getByText('submit implementation confirmation'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('follow-up-collaboration-mode')).toHaveTextContent('default')
    expect(sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '是的，执行此计划',
        modelOptions: { collaborationMode: 'default' },
      })
    )
    expect(sendRuntimeMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({
        requestUserInputResponse: expect.anything(),
      })
    )
  })

  test('queues runtime messages while current response is running', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'claude_code',
                      running: true,
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    expect(screen.getByTestId('composer-input')).toHaveTextContent('')
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-error')).toHaveTextContent('')
  })

  test('queues runtime messages while an assistant stream is active before runtime status refreshes', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runningRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'claude_code',
                  running: true,
                },
              ],
            },
          ],
          totalTasks: 1,
        },
      ],
      totalTasks: 1,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(runningRuntimeWork),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    expect(screen.getByTestId('composer-input')).toHaveTextContent('')
  })

  test('refreshes runtime work when the current runtime task starts streaming', async () => {
    let streamHandlers: Parameters<WorkbenchServices['chatStream']['subscribe']>[0] | null = null
    const subscribe = vi.fn(handlers => {
      streamHandlers = handlers
      return vi.fn()
    })
    const listRuntimeWork = vi.fn().mockResolvedValue(createRuntimeWork())
    const runtimeWorkApi = createRuntimeWorkApiMock({ listRuntimeWork })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    const callsBeforeStart = listRuntimeWork.mock.calls.length

    await act(async () => {
      streamHandlers?.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })

    await waitFor(() => expect(listRuntimeWork).toHaveBeenCalledTimes(callsBeforeStart + 1))
  })

  test('hides the runtime goal when the settled task reports the goal complete', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const getRuntimeGoal = vi
      .fn()
      .mockResolvedValueOnce({
        accepted: true,
        goal: createRuntimeGoal({ objective: '实现目标', status: 'active' }),
      })
      .mockResolvedValueOnce({
        accepted: true,
        goal: createRuntimeGoal({ objective: '实现目标', status: 'complete' }),
      })
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeGoal })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-goal-objective')).toHaveTextContent('实现目标')
    )

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-goal-objective')).toHaveTextContent('none')
    )
  })

  test('keeps an active runtime goal active while the task list is between automatic turns', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'codex',
                      running: false,
                      status: 'idle',
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeGoal: vi.fn().mockResolvedValue({
        accepted: true,
        goal: createRuntimeGoal({ status: 'active' }),
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('idle')
    )
    expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('active')
  })

  test('restores a goal task as running when reopened with a streaming transcript', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'codex',
                      running: false,
                      status: 'active',
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        running: true,
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: '继续实现目标' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: '正在输出',
            status: 'streaming',
            subtaskId: '101',
          },
        ],
      }),
      getRuntimeGoal: vi.fn().mockResolvedValue({
        accepted: true,
        goal: createRuntimeGoal({ status: 'active' }),
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-message-statuses')).toHaveTextContent(
        'assistant:streaming'
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('running')
    )
    expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('active')
  })

  test('reconciles a running task from its transcript when the renderer missed terminal events', async () => {
    const runningWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'codex',
                  running: true,
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    const getRuntimeTranscript = vi
      .fn()
      .mockResolvedValueOnce({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        running: true,
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: '继续后台任务' }],
      })
      .mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        running: false,
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: '继续后台任务' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: '后台任务已完成',
            status: 'done',
            subtaskId: '101',
          },
        ],
      })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(runningWork),
      getRuntimeTranscript,
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([createDevice({ device_type: 'local' })]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('running')
    )
    await waitFor(() => expect(screen.getByText('后台任务已完成')).toBeInTheDocument(), {
      timeout: 5_000,
    })
    expect(getRuntimeTranscript).toHaveBeenLastCalledWith({
      deviceId: 'device-1',
      taskId: 'runtime-a',
      workspacePath: '/workspace/project-alpha',
      limit: 50,
      refresh: true,
    })
  })

  test('restores partial output only after the local runtime transport is replaced', async () => {
    const runningWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'codex',
                  running: true,
                },
              ],
            },
          ],
          totalTasks: 1,
        },
      ],
      totalTasks: 1,
    })
    const getRuntimeTranscript = vi
      .fn()
      .mockResolvedValueOnce({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        running: true,
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: '执行命令' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: '已经输出的中间内容',
            status: 'streaming',
            subtaskId: '101',
          },
        ],
      })
      .mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        running: false,
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: '执行命令' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: '已经输出的中间内容',
            status: 'streaming',
            subtaskId: '101',
          },
        ],
      })
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(runningWork),
      getRuntimeTranscript,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: { subscribe } as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-message-statuses')).toHaveTextContent(
        'assistant:streaming'
      )
    )
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)

    await act(async () => {
      streamHandlers.onRuntimeTransportReplaced?.({
        previousRuntimeInstanceId: 'runtime-instance-a',
        runtimeInstanceId: 'runtime-instance-b',
      })
    })

    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(2))
    expect(getRuntimeTranscript).toHaveBeenLastCalledWith({
      deviceId: 'device-1',
      taskId: 'runtime-a',
      workspacePath: '/workspace/project-alpha',
      limit: 50,
      refresh: true,
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-message-statuses')).toHaveTextContent('assistant:done')
    )
    expect(screen.getByText('已经输出的中间内容')).toBeInTheDocument()
    expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('idle')
  })

  test('resumes a paused runtime goal when editing and sending its objective', async () => {
    const setRuntimeGoal = vi.fn().mockResolvedValue({
      accepted: true,
      goal: createRuntimeGoal({ objective: '更新后的目标', status: 'active' }),
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'codex',
                      running: false,
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeGoal: vi.fn().mockResolvedValue({
        accepted: true,
        goal: createRuntimeGoal({ status: 'paused' }),
      }),
      setRuntimeGoal,
      sendRuntimeMessage: vi.fn().mockResolvedValue({ accepted: true, taskId: 'runtime-a' }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('paused')
    )
    await userEvent.click(screen.getByText('edit runtime goal'))
    await userEvent.click(screen.getByText('set edited runtime goal'))
    await userEvent.click(screen.getByText('send runtime goal'))

    await waitFor(() =>
      expect(setRuntimeGoal).toHaveBeenCalledWith({
        address: {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          taskId: 'runtime-a',
        },
        objective: '更新后的目标',
        status: 'active',
      })
    )
    expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('active')
  })

  test('accepts current runtime stream blocks when device id is omitted', async () => {
    let streamHandlers: Parameters<WorkbenchServices['chatStream']['subscribe']>[0] | null = null
    const subscribe = vi.fn(handlers => {
      if (handlers.onBlockCreated) streamHandlers = handlers
      return vi.fn()
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    await waitFor(() => expect(streamHandlers?.onChatStart).toBeDefined())
    await waitFor(() => expect(streamHandlers?.onBlockCreated).toBeDefined())

    await act(async () => {
      streamHandlers?.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Codex',
      })
    })

    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent('正在思考')

    await act(async () => {
      streamHandlers?.onBlockCreated?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        block: {
          id: 'tool-1',
          type: 'tool',
          tool_name: 'exec_command',
          status: 'pending',
        },
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
        'tool:exec_command:pending'
      )
    )
  })

  test('sends queued runtime messages when the task becomes idle', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runningRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'claude_code',
                  running: true,
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    const idleRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'claude_code',
                  running: false,
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    let runtimeRunning = true
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(runtimeRunning ? runningRuntimeWork : idleRuntimeWork)
        ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')

    runtimeRunning = false
    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
    })
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))
  })

  test('waits for the sent queued runtime message to start before sending the next queued item', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runningRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'claude_code',
                  running: true,
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    const idleRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'claude_code',
                  running: false,
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    let runtimeRunning = true
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(runtimeRunning ? runningRuntimeWork : idleRuntimeWork)
        ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('set ls follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修|queued:执行ls')

    runtimeRunning = false
    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
    })
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:执行ls')
  })

  test('edits queued runtime messages back into the composer', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'claude_code',
                      running: true,
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('edit first queued'))

    expect(screen.getByTestId('composer-input')).toHaveTextContent('继续修')
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('')
  })

  test('sends queued guidance through native runtime guidance without cancelling the turn', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const guidanceResult = deferred<RuntimeGuidanceResponse>()
    const guideRuntimeTask = vi.fn().mockReturnValue(guidanceResult.promise)
    const cancelRuntimeTask = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'claude_code',
                      running: true,
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
          },
        ],
      }),
      sendRuntimeMessage,
      guideRuntimeTask,
      cancelRuntimeTask,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        content: 'before ',
        offset: 0,
        deviceId: 'device-1',
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
        'first message|working|before '
      )
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    const queuedMessageId = screen.getByTestId('queued-message-ids').textContent
    await userEvent.click(screen.getByText('guide first queued'))

    await waitFor(() => expect(guideRuntimeTask).toHaveBeenCalledTimes(1))
    expect(guideRuntimeTask).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      message: '继续修',
      clientGuidanceId: expect.stringMatching(/^queued-runtime-pane-/),
    })
    expect(cancelRuntimeTask).not.toHaveBeenCalled()
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('sending:继续修')
    expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
      'first message|working|before '
    )
    expect(screen.getByTestId('runtime-open-blocks')).not.toHaveTextContent(
      'tool:conversation_guidance:done'
    )
    expect(screen.getByTestId('guidance-messages')).toHaveTextContent('')

    await act(async () => {
      guidanceResult.resolve({
        accepted: true,
        success: true,
        taskId: 'runtime-a',
        guidanceId: 'queued-runtime-guidance',
        turnId: '019f4c02-df59-71c3-ac19-f1e7cec46069',
      })
    })
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('sending:继续修')
    expect(screen.getByTestId('runtime-open-blocks')).not.toHaveTextContent(
      'tool:conversation_guidance:done'
    )

    await act(async () => {
      streamHandlers.onGuidanceApplied?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        guidanceId: 'raw-guidance-item',
        message: '继续修',
        appliedAtMs: Date.now(),
      })
    })
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))
    expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
      'first message|working|before |继续修|'
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
      'tool:conversation_guidance:done'
    )
    expect(screen.getByTestId('runtime-open-message-ids')).toHaveTextContent(queuedMessageId ?? '')

    await act(async () => {
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        content: 'after',
        offset: 0,
        deviceId: 'device-1',
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
        'first message|working|before |继续修|after'
      )
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
      'tool:conversation_guidance:done'
    )
    await act(async () => {
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        content: ' more',
        offset: 5,
        deviceId: 'device-1',
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('after more')
    )
    expect(screen.getByTestId('runtime-content-truncation')).not.toHaveTextContent('truncated')

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'before after more' },
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
        'first message|working|before |继续修|after more'
      )
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
      'tool:conversation_guidance:done'
    )
  })

  test('sends a busy goal message as guidance when requested by submit options', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const guideRuntimeTask = vi.fn().mockResolvedValue({
      accepted: true,
      success: true,
      taskId: 'runtime-a',
      guidanceId: 'shortcut-runtime-guidance',
    })
    const setRuntimeGoal = vi.fn().mockResolvedValue({
      accepted: true,
      goal: createRuntimeGoal({ objective: '继续修', status: 'active' }),
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'claude_code',
                      running: true,
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
          },
        ],
      }),
      sendRuntimeMessage,
      guideRuntimeTask,
      setRuntimeGoal,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up goal'))
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('add local image attachment'))
    await userEvent.click(screen.getByText('send follow-up as guidance'))

    await waitFor(() => expect(guideRuntimeTask).toHaveBeenCalledTimes(1))
    expect(setRuntimeGoal).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      objective: '继续修',
      status: 'active',
    })
    await act(async () => {
      streamHandlers.onGuidanceApplied?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        guidanceId: 'raw-guidance-item',
        message: '继续修',
        appliedAtMs: Date.now(),
      })
    })
    expect(guideRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '继续修',
        attachments: [
          expect.objectContaining({
            local_path: LOCAL_IMAGE_ATTACHMENT_PATH,
            mime_type: 'image/png',
          }),
        ],
      })
    )
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('')
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-goal-flags')).toHaveTextContent('goal:继续修')
    expect(screen.getByTestId('runtime-open-message-ids')).toHaveTextContent('queued-runtime-pane-')
  })

  test('suppresses an in-flight guidance after interrupt-and-send replaces it', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const guidanceResult = deferred<RuntimeGuidanceResponse>()
    const guideRuntimeTask = vi.fn().mockReturnValue(guidanceResult.promise)
    const sendRuntimeMessage = vi.fn().mockResolvedValue({ accepted: true, taskId: 'runtime-a' })
    const interruptResult = deferred<{ accepted: boolean; taskId: string }>()
    const interruptAndSendRuntimeMessage = vi.fn().mockReturnValue(interruptResult.promise)
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'claude_code',
                      running: true,
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
          },
        ],
      }),
      sendRuntimeMessage,
      guideRuntimeTask,
      interruptAndSendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: { subscribe } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('guide first queued'))
    await waitFor(() => expect(guideRuntimeTask).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByTestId('queued-interrupt-and-send-first'))
    await waitFor(() => expect(interruptAndSendRuntimeMessage).toHaveBeenCalledTimes(1))

    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '102',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-a',
        subtaskId: '102',
        content: 'replacement',
        offset: 0,
        deviceId: 'device-1',
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
        'first message|working||继续修|replacement'
      )
    )

    await act(async () => {
      interruptResult.resolve({ accepted: true, taskId: 'runtime-a' })
    })
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))

    await act(async () => {
      guidanceResult.resolve({
        accepted: false,
        success: false,
        taskId: 'runtime-a',
        error: 'no active turn to guide',
        code: 'no_active_turn',
      })
    })

    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
  })

  test('restores code comments when interrupt-and-send fails', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const interruptAndSendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: false,
      success: false,
      error: 'interrupt failed',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'claude_code',
                      running: true,
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
          },
        ],
      }),
      interruptAndSendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: { subscribe } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByTestId('follow-up-add-code-comment'))
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    expect(screen.getByTestId('code-comment-context-count')).toHaveTextContent('0')

    await userEvent.click(screen.getByTestId('queued-interrupt-and-send-first'))

    await waitFor(() => expect(interruptAndSendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('继续修')
    expect(screen.getByTestId('code-comment-context-count')).toHaveTextContent('1')
  })

  test('marks queued guidance failed when native runtime guidance fails', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const guideRuntimeTask = vi.fn().mockResolvedValue({
      accepted: false,
      success: false,
      error: 'no active turn to guide',
    })
    const cancelRuntimeTask = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'claude_code',
                      running: true,
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
          },
        ],
      }),
      sendRuntimeMessage,
      guideRuntimeTask,
      cancelRuntimeTask,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('guide first queued'))

    await waitFor(() => expect(guideRuntimeTask).toHaveBeenCalledTimes(1))
    expect(cancelRuntimeTask).not.toHaveBeenCalled()
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByTestId('queued-messages')).toHaveTextContent('failed:继续修')
    )
    expect(screen.getByTestId('queued-errors')).toHaveTextContent('引导发送失败')
    expect(screen.getByTestId('queued-notices')).not.toHaveTextContent('正在引导当前对话')
  })

  test('sends queued guidance as a follow-up when the active turn is unavailable', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValueOnce(false).mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const guideRuntimeTask = vi.fn().mockResolvedValue({
      accepted: false,
      success: false,
      taskId: 'runtime-a',
      error: 'no active turn to guide',
      code: 'no_active_turn',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'claude_code',
                      running: true,
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
          },
        ],
      }),
      sendRuntimeMessage,
      guideRuntimeTask,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('queued-messages')).toHaveTextContent('failed:继续修')
    )

    await userEvent.click(screen.getByText('guide first queued'))

    await waitFor(() => expect(guideRuntimeTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(2))
    expect(sendRuntimeMessage).toHaveBeenLastCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
    })
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))
  })

  test('pauses an active task goal before cancelling while goal details are loading', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const runningRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'codex',
                  running: true,
                  goalStatus: 'active',
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    const idleRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'codex',
                  running: false,
                  status: 'cancelled',
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    let runtimeRunning = true
    const listRuntimeWork = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(runtimeRunning ? runningRuntimeWork : idleRuntimeWork)
      )
    const cancelRuntimeTask = vi.fn().mockImplementation(() => {
      expect(setRuntimeGoal).toHaveBeenCalledWith({
        address: {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          taskId: 'runtime-a',
        },
        status: 'paused',
      })
      runtimeRunning = false
      return Promise.resolve({
        accepted: true,
        taskId: 'runtime-a',
      })
    })
    const setRuntimeGoal = vi.fn().mockResolvedValue({
      accepted: true,
      goal: createRuntimeGoal({ status: 'paused' }),
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork,
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
          },
        ],
      }),
      cancelRuntimeTask,
      getRuntimeGoal: vi.fn().mockReturnValue(new Promise(() => undefined)),
      setRuntimeGoal,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('running')
    )
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await waitFor(() => expect(runtimeWorkApi.getRuntimeGoal).toHaveBeenCalledTimes(1))
    const listCallsBeforeCancel = listRuntimeWork.mock.calls.length
    await userEvent.click(screen.getByText('stop current response'))

    await waitFor(() => expect(cancelRuntimeTask).toHaveBeenCalledTimes(1))
    expect(cancelRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      taskId: 'runtime-a',
    })
    await waitFor(() =>
      expect(setRuntimeGoal).toHaveBeenCalledWith({
        address: {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          taskId: 'runtime-a',
        },
        status: 'paused',
      })
    )
    await waitFor(() =>
      expect(listRuntimeWork.mock.calls.length).toBeGreaterThan(listCallsBeforeCancel)
    )
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('idle')
    )
    await waitFor(() =>
      expect(screen.getByTestId('runtime-message-statuses')).not.toHaveTextContent(
        'assistant:streaming'
      )
    )
  })

  test('sends queued guidance through native runtime guidance without DB task context', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const guideRuntimeTask = vi.fn().mockResolvedValue({
      accepted: true,
      success: true,
      taskId: 'runtime-a',
      guidanceId: 'queued-runtime-guidance',
    })
    const cancelRuntimeTask = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'claude_code',
                      running: true,
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
      guideRuntimeTask,
      cancelRuntimeTask,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set ls follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('guide first queued'))

    await waitFor(() => expect(guideRuntimeTask).toHaveBeenCalledTimes(1))
    expect(guideRuntimeTask).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      message: '执行ls',
      clientGuidanceId: expect.stringMatching(/^queued-runtime-pane-/),
    })
    await act(async () => {
      streamHandlers.onGuidanceApplied?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        guidanceId: 'raw-guidance-item',
        message: '执行ls',
        appliedAtMs: Date.now(),
      })
    })
    expect(cancelRuntimeTask).not.toHaveBeenCalled()
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('')
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('执行ls')
    expect(screen.getByTestId('queued-errors')).not.toHaveTextContent('当前回复缺少引导上下文')
    expect(screen.getByTestId('guidance-messages')).toHaveTextContent('')
  })

  test('sends image attachments with current runtime task follow-up messages', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('add image attachment'))
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('1')
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('0')
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
      attachmentIds: [45],
    })
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-error')).toHaveTextContent('')
  })

  test('sends local image attachments with current runtime task follow-up messages', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('add local image attachment'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
      attachments: [
        expect.objectContaining({
          id: -45,
          filename: 'photo.png',
          local_path: LOCAL_IMAGE_ATTACHMENT_PATH,
          local_preview_url: LOCAL_IMAGE_ATTACHMENT_PATH,
        }),
      ],
    })
  })

  test('loads local skills and apps from Codex app-server', async () => {
    setTauriRuntime()
    localExecutorMocks.requestLocalExecutor.mockImplementation(
      async (method: string, params?: unknown) => {
        if (method === 'runtime.tasks.list') {
          return { projects: [], chats: [], totalTasks: 0 }
        }
        if (
          method === 'codex.app_server_request' &&
          params &&
          typeof params === 'object' &&
          (params as { method?: unknown }).method === 'skills/list'
        ) {
          return {
            data: [
              {
                cwd: '/workspace/runtime-device',
                skills: [
                  {
                    name: 'env-context',
                    description: 'Environment facts',
                    path: '/Users/crystal/.codex/skills/env-context/SKILL.md',
                    scope: 'user',
                    enabled: true,
                  },
                ],
                errors: [],
              },
            ],
          }
        }
        if (
          method === 'codex.app_server_request' &&
          params &&
          typeof params === 'object' &&
          (params as { method?: unknown }).method === 'app/list'
        ) {
          return {
            data: [
              {
                id: 'google-calendar',
                name: 'Google Calendar',
                description: 'Manage calendar events',
                isAccessible: true,
                isEnabled: true,
              },
            ],
            nextCursor: null,
          }
        }
        return {}
      }
    )
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi
          .fn()
          .mockResolvedValue([
            createDevice({ device_id: 'device-1', name: 'Default Device' }),
            createDevice({ id: 2, device_id: 'runtime-device', name: 'Runtime Device' }),
          ]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: createRuntimeWorkApiMock({
        getRuntimeTranscript: vi.fn(async (address: RuntimeTaskAddress) => ({
          taskId: address.taskId,
          workspacePath: address.workspacePath,
          runtime: 'codex',
          messages: [],
        })),
      }) as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeTaskSkillsProbe />, services)

    await userEvent.click(screen.getByText('open runtime skill task'))
    await waitFor(() =>
      expect(services.runtimeWorkApi?.getRuntimeTranscript).toHaveBeenCalledWith({
        deviceId: 'runtime-device',
        workspacePath: '/workspace/runtime-device',
        taskId: 'runtime-skill-task',
        limit: 50,
      })
    )

    await userEvent.click(screen.getByText('list local skills'))

    await waitFor(() => {
      expect(localExecutorMocks.requestLocalExecutor).toHaveBeenCalledWith(
        'codex.app_server_request',
        {
          method: 'skills/list',
          params: {
            cwds: ['/workspace/runtime-device'],
            forceReload: false,
          },
        }
      )
    })

    await userEvent.click(screen.getByText('list local apps'))

    await waitFor(() => {
      expect(localExecutorMocks.requestLocalExecutor).toHaveBeenCalledWith(
        'codex.app_server_request',
        {
          method: 'app/list',
          params: {
            cursor: null,
            limit: 100,
            forceRefetch: false,
          },
        }
      )
    })
  })

  test('ignores stream events from a previously selected runtime task', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-b',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-b'
      )
    )

    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        offset: 0,
        result: { value: 'stale runtime a output' },
        deviceId: 'device-1',
      })
      streamHandlers.onChatStart?.({
        taskId: 'runtime-b',
        subtaskId: '102',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
      streamHandlers.onChatDone?.({
        taskId: 'runtime-b',
        subtaskId: '102',
        offset: 0,
        result: { value: 'current runtime b output' },
        deviceId: 'device-1',
      })
    })

    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent(
      'current runtime b output'
    )
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent(
      'stale runtime a output'
    )
  })
})
