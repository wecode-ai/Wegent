import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  createContext,
  StrictMode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { LOCAL_USER } from '@/api/local/localSession'
import { resetLocalRuntimeChatStreamsForTests } from '@/api/local/localServices'
import i18n from '@/i18n'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import {
  LOCAL_PLUGIN_SKILLS_CHANGED_EVENT,
  PLUGIN_TRIAL_QUEUED_EVENT,
} from '@/features/plugins/pluginTrial'
import { buildAutomationTaskOptions } from '@/features/automations/automationDraft'
import { WorkbenchProvider, type WorkbenchServices } from './WorkbenchProvider'
import { useWorkbench } from './useWorkbench'
import { MessageList } from '@/components/chat/MessageList'
import { TaskPlanProgress } from '@/components/chat/composer/TaskPlanProgress'
import {
  RUNTIME_RETRY_CONTINUATION_PROMPT,
  useWorkbenchPaneSession,
} from '@/components/layout/useWorkbenchPaneSession'
import { buildRuntimeTaskRoute, parseRuntimeTaskRoute } from '@/lib/navigation'
import { getWorkbenchDebugSnapshot } from '@/lib/debugPanel'
import { runtimeProjectUiId, standaloneRuntimeProjectKey } from '@/lib/runtime-project'
import { findRuntimeTask, readLastProjectId, writeLastProjectId } from './workbenchRuntimeHelpers'
import { useRuntimeTaskRouteRestoration } from './useRuntimeTaskRouteRestoration'
import { modelSelectionFromRuntimeHandle } from './runtimeContextUsage'
import { writeCachedRemoteRuntimeWork } from './remoteRuntimeWorkCache'
import {
  WorkspaceTabsContext,
  type WorkspaceTabsContextValue,
} from '@/features/workspace-tabs/workspaceTabsContextValue'
import {
  RuntimeTaskLifecycleStreamCoordinator,
  RuntimeTaskLifecycleStore,
  useRuntimeTaskLifecycle,
  useRuntimeTaskLifecycleStore,
  useRuntimeTaskLifecycleStoreSnapshot,
} from './runtimeTaskLifecycle'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import {
  getWorkbenchPaneKey,
  type WorkbenchPaneIdentity,
} from '@/components/layout/workbenchPaneIdentity'
import {
  applyRuntimeConversationAction,
  cacheRuntimeConversationQueuedMessages,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
  getRuntimeConversationQueuedMessages,
} from './runtimeConversationCache'
import { createRuntimeUserMessage } from './runtimeUserMessage'
import {
  getComposerApps,
  resetComposerAppsMemory,
} from '@/components/chat/composer/composerAppsSnapshot'
import type {
  Attachment,
  DeviceInfo,
  InstalledPlugin,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeTaskCreateResponse,
  RuntimeGoal,
  RuntimeGoalGetResponse,
  RuntimeGuidanceResponse,
  NormalizedRuntimeMessage,
  RuntimeTranscriptResponse,
  RuntimeTranscriptRequest,
  RuntimeTranscriptTurn,
  Team,
  TurnFileChangesSummary,
  RuntimeWorkListResponse,
  UnifiedModel,
  User,
} from '@/types/api'

const localExecutorMocks = vi.hoisted(() => ({
  connectLocalExecutorToBackend: vi.fn().mockResolvedValue({ running: true, ready: true }),
  disconnectLocalExecutorFromBackend: vi.fn().mockResolvedValue({ running: true, ready: true }),
  ensureBundledPluginMarketplaceRegistered: vi.fn().mockResolvedValue(undefined),
  ensureLocalExecutorStarted: vi.fn(),
  getInitializedBundledPluginMarketplace: vi.fn().mockReturnValue(null),
  getKnownLocalExecutorDeviceId: vi.fn().mockReturnValue('local-device'),
  requestLocalExecutor: vi.fn(),
  subscribeLocalExecutorEvents: vi.fn(),
}))

const pluginApiMocks = vi.hoisted(() => ({
  cloudListInstalledPlugins: vi.fn(),
}))

const runtimeWorkSyncMocks = vi.hoisted(() => ({
  installMainRuntimeWorkChangedListener: vi.fn(() => null),
  notifyMainRuntimeWorkChanged: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/plugins', () => ({
  createPluginApi: () => ({
    listInstalledPlugins: pluginApiMocks.cloudListInstalledPlugins,
  }),
}))

vi.mock('@/desktop/localExecutor', () => ({
  connectLocalExecutorToBackend: localExecutorMocks.connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend: localExecutorMocks.disconnectLocalExecutorFromBackend,
  ensureBundledPluginMarketplaceRegistered:
    localExecutorMocks.ensureBundledPluginMarketplaceRegistered,
  ensureLocalExecutorStarted: localExecutorMocks.ensureLocalExecutorStarted,
  getInitializedBundledPluginMarketplace: localExecutorMocks.getInitializedBundledPluginMarketplace,
  getKnownLocalExecutorDeviceId: localExecutorMocks.getKnownLocalExecutorDeviceId,
  requestLocalExecutor: localExecutorMocks.requestLocalExecutor,
  subscribeLocalExecutorEvents: localExecutorMocks.subscribeLocalExecutorEvents,
}))

vi.mock('@/desktop/runtimeWorkSync', () => runtimeWorkSyncMocks)

function setElectronRuntime() {
  window.__WEWORK_RUNTIME_CONFIG__ = {
    ...window.__WEWORK_RUNTIME_CONFIG__,
    desktopHost: 'electron',
  }
}

function clearElectronRuntime() {
  delete window.__WEWORK_RUNTIME_CONFIG__
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

const LOCAL_IMAGE_ATTACHMENT_PATH = '/Users/me/.wework/workspace/attachments/draft/-45/photo.png'

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
  const api = {
    prepareRuntimeModel: vi.fn().mockResolvedValue(true),
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
    upsertLocalRuntimeProject: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      projectKey: 'multi-project',
      name: 'web',
      roots: ['/workspace/web', '/workspace/api'],
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
  const getRuntimeTranscript = api.getRuntimeTranscript as (
    request: RuntimeTranscriptRequest
  ) => Promise<RuntimeTranscriptResponse>
  api.getRuntimeTranscript = vi.fn(async (request: RuntimeTranscriptRequest) =>
    withCanonicalTranscriptTurns(await getRuntimeTranscript(request))
  )
  return api
}

function withCanonicalTranscriptTurns(
  transcript: RuntimeTranscriptResponse
): RuntimeTranscriptResponse {
  if (Array.isArray(transcript.turns)) return transcript
  return {
    ...transcript,
    turns: canonicalTranscriptTurnsFromMessages(transcript.messages ?? []),
  }
}

function canonicalTranscriptTurnsFromMessages(
  messages: NormalizedRuntimeMessage[]
): RuntimeTranscriptTurn[] {
  const turns: RuntimeTranscriptTurn[] = []
  const turnsById = new Map<string, RuntimeTranscriptTurn>()
  let pendingUsers: NormalizedRuntimeMessage[] = []

  const getTurn = (turnId: string) => {
    const existing = turnsById.get(turnId)
    if (existing) return existing
    const turn: RuntimeTranscriptTurn = {
      id: turnId,
      items: [],
      status: 'done',
      runtimeStatus: 'done',
    }
    turnsById.set(turnId, turn)
    turns.push(turn)
    return turn
  }

  const appendUser = (turn: RuntimeTranscriptTurn, message: NormalizedRuntimeMessage) => {
    const clientUserMessageId = message.clientUserMessageId ?? message.id
    if (
      typeof message.messageIndex === 'number' &&
      (turn.messageIndex === undefined ||
        turn.messageIndex === null ||
        message.messageIndex < turn.messageIndex)
    ) {
      turn.messageIndex = message.messageIndex
    }
    turn.items.push({
      id: clientUserMessageId,
      type: 'user_message',
      message: {
        ...message,
        clientUserMessageId,
        subtaskId: turn.id,
        turnId: turn.id,
      },
    })
  }

  for (const message of messages) {
    const explicitTurnId = message.turnId ?? message.subtaskId
    if (message.role === 'user' && explicitTurnId === undefined) {
      pendingUsers.push(message)
      continue
    }

    const turnId = String(explicitTurnId ?? `fixture-turn:${message.id}`)
    const turn = getTurn(turnId)
    if (
      typeof message.messageIndex === 'number' &&
      (turn.messageIndex === undefined ||
        turn.messageIndex === null ||
        message.messageIndex < turn.messageIndex)
    ) {
      turn.messageIndex = message.messageIndex
    }
    pendingUsers.forEach(user => appendUser(turn, user))
    pendingUsers = []

    if (message.role === 'user') {
      appendUser(turn, message)
      continue
    }
    if (message.role !== 'assistant') continue

    if (message.content) {
      turn.items.push({
        id: message.id,
        type: 'assistant_text',
        content: message.content,
        createdAt: message.createdAt,
      })
    }
    for (const block of message.blocks ?? []) {
      if (!block.id) continue
      turn.items.push({
        id: String(block.id),
        type: 'block',
        block:
          block.createdAt !== undefined || block.created_at !== undefined
            ? block
            : {
                ...block,
                createdAt: Date.parse(message.createdAt ?? new Date().toISOString()),
              },
      })
    }
    turn.status = message.status ?? 'done'
    turn.runtimeStatus = message.runtimeStatus ?? message.status ?? 'done'
    turn.completedAt = message.completedAt
    turn.error = message.error
    turn.errorType = message.errorType
    turn.stoppedNotice = message.stoppedNotice
    turn.fileChanges = message.fileChanges
  }

  for (const user of pendingUsers) {
    appendUser(getTurn(`fixture-turn:${user.id}`), user)
  }
  return turns
}

function createWorkbenchServices(overrides: Partial<WorkbenchServices> = {}): WorkbenchServices {
  const base = {
    teamApi: {
      listTeams: vi.fn().mockResolvedValue([]),
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
      <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
        <WorkbenchProbeSessionProvider>{children}</WorkbenchProbeSessionProvider>
      </WorkbenchProvider>
    </CloudConnectionContext.Provider>
  )
}

function renderWorkbenchWithLifecycleCoordinator(
  children: React.ReactNode,
  services = createWorkbenchServices()
) {
  const cloudConnectionValue: CloudConnectionContextValue = {
    ...DISCONNECTED_STATE,
    isConnected: false,
    serviceKey: 'test-disconnected',
    connectWithAuthorization: vi.fn(),
    refreshUser: vi.fn(),
    disconnect: vi.fn(),
  }
  const lifecycleStore = new RuntimeTaskLifecycleStore('test')
  const subscribers = new Set<ChatStreamHandlers>()
  let unsubscribeUpstream: (() => void) | null = null
  const dispatcher = new Proxy<ChatStreamHandlers>(
    {},
    {
      get: (_, property) => {
        if (property === 'scope') return undefined
        return (payload: unknown) => {
          for (const handlers of subscribers) {
            const callback = handlers[property as keyof ChatStreamHandlers]
            if (typeof callback === 'function') {
              ;(callback as (value: unknown) => void)(payload)
            }
          }
        }
      },
    }
  )
  const coordinatedServices: WorkbenchServices = {
    ...services,
    chatStream: {
      ...services.chatStream,
      subscribe: handlers => {
        subscribers.add(handlers)
        unsubscribeUpstream ??= services.chatStream.subscribe(dispatcher)
        return () => {
          subscribers.delete(handlers)
          if (subscribers.size === 0) {
            unsubscribeUpstream?.()
            unsubscribeUpstream = null
          }
        }
      },
    },
  }
  return render(
    <CloudConnectionContext.Provider value={cloudConnectionValue}>
      <RuntimeTaskLifecycleStreamCoordinator
        services={coordinatedServices}
        store={lifecycleStore}
      />
      <WorkbenchProvider
        lifecycleStore={lifecycleStore}
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={coordinatedServices}
      >
        <WorkbenchProbeSessionProvider>{children}</WorkbenchProbeSessionProvider>
      </WorkbenchProvider>
    </CloudConnectionContext.Provider>
  )
}

function renderWorkbenchForUser(
  children: React.ReactNode,
  user: User,
  services = createWorkbenchServices()
) {
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
      <WorkbenchProvider user={user} services={services}>
        <WorkbenchProbeSessionProvider>{children}</WorkbenchProbeSessionProvider>
      </WorkbenchProvider>
    </CloudConnectionContext.Provider>
  )
}

function renderStrictWorkbench(children: React.ReactNode, services = createWorkbenchServices()) {
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
      <StrictMode>
        <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
          {children}
        </WorkbenchProvider>
      </StrictMode>
    </CloudConnectionContext.Provider>
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
    !handlers.scope &&
    (handlers.onChatStart ||
      handlers.onChatChunk ||
      handlers.onChatDone ||
      handlers.onChatError ||
      handlers.onBlockCreated ||
      handlers.onBlockUpdated)
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

  return (
    <WorkbenchProbePaneSession
      key={getWorkbenchPaneKey({
        currentRuntimeTask,
        currentProject: workbenchState.currentProject,
        standaloneChatKey: workbenchState.standaloneChatKey,
      })}
      workbench={workbench}
      currentRuntimeTask={currentRuntimeTask}
    >
      {children}
    </WorkbenchProbePaneSession>
  )
}

function WorkbenchProbePaneSession({
  children,
  workbench,
  currentRuntimeTask,
}: {
  children: React.ReactNode
  workbench: ReturnType<typeof useWorkbench>
  currentRuntimeTask: RuntimeTaskAddress | null
}) {
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
      <span data-testid="device-ids">
        {workbench.state.devices.map(device => device.device_id).join('|')}
      </span>
      <button type="button" onClick={() => void workbench.refreshDevices()}>
        Refresh devices
      </button>
      <button type="button" onClick={() => void workbench.refreshWorkLists()}>
        Refresh work lists
      </button>
      <button type="button" onClick={() => workbench.projectChat.requestCatalogs?.()}>
        Load task composer catalogs
      </button>
    </div>
  )
}

function RuntimeTaskPinProbe() {
  const workbench = useWorkbench()
  const [error, setError] = useState('')
  const task = workbench.state.runtimeWork?.projects[0]?.deviceWorkspaces[0]?.tasks[0]
  const automationTaskIds = buildAutomationTaskOptions(workbench.state.runtimeWork).map(
    option => option.address.taskId
  )

  return (
    <div>
      <span data-testid="runtime-task-pin-state">{task?.pinned ? 'pinned' : 'unpinned'}</span>
      <span data-testid="automation-task-options">{automationTaskIds.join('|') || 'none'}</span>
      <span data-testid="runtime-task-pin-error">{error}</span>
      <button
        type="button"
        data-testid="pin-runtime-task"
        onClick={() =>
          void workbench
            .setRuntimeTaskPinned({
              deviceId: 'state-device',
              threadId: 'thread-a',
              pinned: true,
            })
            .catch(() => setError('failed'))
        }
      >
        pin runtime task
      </button>
      <button
        type="button"
        data-testid="unpin-runtime-task"
        onClick={() =>
          void workbench
            .setRuntimeTaskPinned({
              deviceId: 'state-device',
              threadId: 'thread-a',
              pinned: false,
            })
            .catch(() => setError('failed'))
        }
      >
        unpin runtime task
      </button>
    </div>
  )
}

function RuntimeTaskForkProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="fork-current-runtime-task">
        {workbench.state.currentRuntimeTask?.taskId ?? 'none'}
      </span>
      <span data-testid="fork-current-project">{workbench.state.currentProject?.id ?? 'none'}</span>
      <button
        type="button"
        data-testid="open-fork-source"
        onClick={() =>
          void workbench.openRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-a',
          })
        }
      >
        open fork source
      </button>
      <button
        type="button"
        data-testid="fork-current-runtime-task-action"
        onClick={() =>
          void workbench.forkCurrentRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
          })
        }
      >
        fork current runtime task
      </button>
    </div>
  )
}

function RuntimeTaskPinDuringRefreshProbe() {
  const workbench = useWorkbench()
  const pinRequestedRef = useRef(false)
  const task = workbench.state.runtimeWork?.projects[0]?.deviceWorkspaces[0]?.tasks[0]
  const automationTaskIds = buildAutomationTaskOptions(workbench.state.runtimeWork).map(
    option => option.address.taskId
  )

  useLayoutEffect(() => {
    if (!task || task.pinned || pinRequestedRef.current) return
    pinRequestedRef.current = true
    void workbench.setRuntimeTaskPinned({
      deviceId: 'state-device',
      threadId: 'thread-a',
      pinned: true,
    })
  }, [task, workbench])

  return (
    <div>
      <span data-testid="runtime-task-pin-state">{task?.pinned ? 'pinned' : 'unpinned'}</span>
      <span data-testid="automation-task-options">{automationTaskIds.join('|') || 'none'}</span>
      <button
        type="button"
        data-testid="refresh-runtime-work"
        onClick={() => void workbench.refreshWorkLists()}
      >
        refresh runtime work
      </button>
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

function RuntimeRunningTasksProbe() {
  const lifecycle = useRuntimeTaskLifecycleStoreSnapshot()
  const runningTaskIds = [...lifecycle.runningTaskKeys].map(key => key.split('\0')[1])
  return <span data-testid="runtime-running-task-ids">{runningTaskIds.join('|') || 'none'}</span>
}

const TOP_LEVEL_STREAM_ADDRESS: RuntimeTaskAddress = {
  deviceId: 'device-1',
  workspacePath: '/workspace/project-alpha',
  taskId: 'runtime-a',
}
const EPHEMERAL_STREAM_ADDRESS: RuntimeTaskAddress = {
  ...TOP_LEVEL_STREAM_ADDRESS,
  runtime: 'codex',
}

function RuntimeTopLevelStreamLifecycleProbe() {
  const { subscribeRuntimeTaskStream } = useWorkbench()
  const lifecycle = useRuntimeTaskLifecycle(TOP_LEVEL_STREAM_ADDRESS)

  useEffect(
    () =>
      subscribeRuntimeTaskStream(TOP_LEVEL_STREAM_ADDRESS, {
        onMessageAction: () => undefined,
      }),
    [subscribeRuntimeTaskStream]
  )

  return (
    <span data-testid="top-level-runtime-stream-lifecycle">
      {lifecycle?.derived.isRunning ? 'running' : 'idle'}:{lifecycle?.turn.phase ?? 'missing'}
    </span>
  )
}

function EphemeralRuntimeLifecycleProbe() {
  const workbench = useWorkbench()
  const lifecycleStore = useRuntimeTaskLifecycleStore()

  useEffect(() => {
    lifecycleStore.sendRequested(EPHEMERAL_STREAM_ADDRESS)
    lifecycleStore.sendAccepted(EPHEMERAL_STREAM_ADDRESS)
  }, [lifecycleStore])

  return (
    <button type="button" onClick={() => void workbench.openRuntimeTask(EPHEMERAL_STREAM_ADDRESS)}>
      open ephemeral runtime
    </button>
  )
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

function PluginTrialInputProbe({ testId }: { testId: string }) {
  const { paneSession } = useWorkbenchProbeSession()
  return <span data-testid={testId}>{paneSession.input}</span>
}

function DebugSnapshotInputProbe({ testId, value }: { testId: string; value: string }) {
  const { paneSession } = useWorkbenchProbeSession()
  return (
    <button type="button" data-testid={testId} onClick={() => paneSession.setInput(value)}>
      Set draft
    </button>
  )
}

function ProjectSendProbe({
  prepareRuntimeTask,
}: {
  prepareRuntimeTask?: (
    address: RuntimeTaskAddress
  ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
} = {}) {
  const { workbench, paneSession, currentRuntimeTask } = useWorkbenchProbeSession()
  const taskLifecycle = useRuntimeTaskLifecycle(currentRuntimeTask)
  const imageAttachment = createImageAttachment()
  const localImageAttachment = createLocalImageAttachment()
  const currentRuntimeTaskSummary = findRuntimeTask(workbench.state.runtimeWork, currentRuntimeTask)
  const currentModelSelection =
    currentRuntimeTaskSummary?.modelSelection ??
    modelSelectionFromRuntimeHandle(currentRuntimeTask?.runtimeHandle)
  const backgroundRuntimeTaskModelSelection =
    workbench.projectChat.resolveRuntimeTaskModelSelection({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      taskId: 'runtime-a',
    })

  return (
    <div>
      <span data-testid="current-runtime-task-address">
        {currentRuntimeTask
          ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.taskId}`
          : 'none'}
      </span>
      <span data-testid="background-runtime-task-model">
        {backgroundRuntimeTaskModelSelection.selectedModel?.name ?? 'none'}
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
      <span data-testid="project-browser-annotation-command">
        {paneSession.browserAnnotationCommand
          ? `${paneSession.browserAnnotationCommand.sequence}:${paneSession.browserAnnotationCommand.reason}`
          : 'none'}
      </span>
      <span data-testid="trial-plugin-app">
        {workbench.projectChat.trialPluginApp?.pluginKey ?? 'none'}
      </span>
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
      <span data-testid="project-selected-model">
        {workbench.projectChat.selectedModel?.name ?? 'none'}
      </span>
      <span data-testid="project-reasoning-effort">
        {workbench.projectChat.selectedModelOptions.reasoning ?? 'none'}
      </span>
      <span data-testid="runtime-context-window">
        {workbench.projectChat.contextUsage?.modelContextWindow ?? 'none'}
      </span>
      <span data-testid="project-model-names">
        {workbench.projectChat.models.map(model => model.name).join('|')}
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
      <span data-testid="current-runtime-handle-model-selection">
        {modelSelectionFromRuntimeHandle(currentRuntimeTask?.runtimeHandle)?.modelName ?? 'none'}
      </span>
      <span data-testid="runtime-project-order">
        {workbench.state.runtimeWork?.projects
          .map(projectWork => projectWork.project.name)
          .join('|') ?? ''}
      </span>
      <span data-testid="runtime-project-count">
        {workbench.state.runtimeWork?.projects.length ?? 0}
      </span>
      <span data-testid="runtime-chat-workspaces">
        {workbench.state.runtimeWork?.chats.map(workspace => workspace.workspacePath).join('|') ??
          ''}
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
      <span data-testid="current-created-runtime-task-running">
        {taskLifecycle?.derived.isRunning ? 'running' : 'idle'}
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
      <button
        type="button"
        onClick={() => {
          if (currentRuntimeTask) void workbench.archiveRuntimeTask(currentRuntimeTask)
        }}
      >
        archive current runtime task
      </button>
      <button type="button" onClick={() => workbench.startNewProjectChat(7)}>
        start new project chat
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
        onClick={() => {
          if (!currentRuntimeTask) return
          void workbench.bindRuntimeTaskToImSessions(currentRuntimeTask, ['session-a'])
        }}
      >
        bind runtime task to IM
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
        onClick={() =>
          void workbench.openStandaloneWorkspace('device-1', '/workspace/web', undefined, [
            '/workspace/web',
            '/workspace/api',
          ])
        }
      >
        open multi-root workspace
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openStandaloneWorkspace('device-1', '/workspace/product', 'Product', [
            '/workspace/product',
          ])
        }
      >
        create named local project
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
      <button
        type="button"
        onClick={() =>
          void workbench.openStandaloneWorkspace(
            'device-cloud',
            '/workspace/cloud',
            'Cloud Workspace'
          )
        }
      >
        open cloud standalone workspace
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openStandaloneWorkspace('device-local', '/workspace/cloud', 'Cloud Repo')
        }
      >
        open local workspace over cloud path
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
          const model = workbench.projectChat.models.find(item => item.name === 'override-model')
          if (model) workbench.projectChat.setSelectedModel(model)
        }}
      >
        select override model
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.setSelectedModelOption('reasoning', 'high')}
      >
        set high reasoning
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
        onClick={() =>
          void paneSession.send(undefined, {
            runtime: 'claude_code',
            runtimeExecutablePath: '/tmp/claude',
            modelSelection: {
              modelName: 'local-model:claude-test',
              modelType: 'runtime',
              options: { reasoning: 'high' },
            },
          })
        }
      >
        send with claude runtime
      </button>
      <button
        type="button"
        onClick={() => void paneSession.send(undefined, { cloudProjectId: '841738010351776815' })}
      >
        send with project space
      </button>
      <button
        type="button"
        onClick={() => {
          const project =
            workbench.state.currentProject ??
            workbench.state.projects.find(candidate => candidate.id === 7)
          if (!project) return
          void workbench.createProjectRuntimeTask('修复 CI', {
            project,
            deviceWorkspaceId: 23,
            runtime: 'codex',
            optimisticUserMessage: {
              id: 'board-user-message-1',
              role: 'user',
              content: '修复 CI',
              status: 'done',
            },
            prepareRuntimeTask,
          })
        }}
      >
        send with explicit project workspace
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
      <button type="button" onClick={() => void workbench.refreshWorkLists()}>
        refresh work lists
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
  const runtimeATask = runtimeTasks.find(task => task.taskId === 'runtime-a')

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
      <span data-testid="runtime-a-task-status">{runtimeATask?.status ?? 'none'}</span>
      <span data-testid="runtime-a-supervisor-last-evaluated">
        {runtimeATask?.supervisor?.lastEvaluatedAt ?? 'none'}
      </span>
      <span data-testid="runtime-pane-standalone-chat-key">
        {workbench.state.standaloneChatKey}
      </span>
      <RuntimePaneStackItem
        key={getWorkbenchPaneKey({
          currentRuntimeTask: workbench.state.currentRuntimeTask,
          currentProject: workbench.state.currentProject,
          standaloneChatKey: workbench.state.standaloneChatKey,
        })}
        pane={{
          currentRuntimeTask: workbench.state.currentRuntimeTask,
          currentProject: workbench.state.currentProject,
          standaloneChatKey: workbench.state.standaloneChatKey,
        }}
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
    <>
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
    </>
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

function RuntimePaneAddressHydrationProbe() {
  const [address, setAddress] = useState<RuntimeTaskAddress>({
    deviceId: 'device-1',
    taskId: 'runtime-a',
  })
  const paneSession = useWorkbenchPaneSession({ currentRuntimeTask: address })

  return (
    <div>
      <span data-testid="hydrated-runtime-messages">
        {paneSession.messages.map(message => message.content).join('|')}
      </span>
      <span data-testid="hydrated-runtime-transcript-error">
        {paneSession.transcriptError ?? 'none'}
      </span>
      <span data-testid="hydrated-runtime-goal">{paneSession.goal?.objective ?? 'none'}</span>
      <button
        type="button"
        onClick={() =>
          setAddress({
            deviceId: 'device-1',
            taskId: 'runtime-a',
            runtime: 'codex',
            threadId: 'thread-a',
            workspacePath: '/workspace/project-alpha',
          })
        }
      >
        hydrate runtime address
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
      <span data-testid="mutation-error">{workbench.state.error ?? ''}</span>
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
      <button type="button" onClick={() => void workbench.removeProject(7).catch(() => undefined)}>
        remove runtime project
      </button>
      <button type="button" onClick={() => void workbench.refreshWorkLists()}>
        refresh runtime projects
      </button>
    </div>
  )
}

function ProjectWorkPreferenceProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="project-work-preference-error">{workbench.state.error ?? ''}</span>
      <span data-testid="current-project-id">{workbench.state.currentProject?.id ?? 'none'}</span>
      <span data-testid="project-execution-mode">{workbench.projectExecutionMode}</span>
      <span data-testid="project-worktree-branch">{workbench.projectWorktreeBranch ?? ''}</span>
      <button type="button" onClick={() => workbench.selectProjectWorkspace(7, 22)}>
        select project 7 workspace 22
      </button>
      <button type="button" onClick={() => workbench.selectProjectWorkspace(7, 23)}>
        select project 7 workspace 23
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
          void workbench.openRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/worktrees/9/project-alpha',
            taskId: 'runtime-worktree',
          })
        }
      >
        open archive target
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
      <button type="button" onClick={() => void workbench.refreshWorkLists()}>
        refresh work lists
      </button>
    </div>
  )
}

function RuntimeOpenProbe() {
  const { workbench, paneSession, currentRuntimeTask } = useWorkbenchProbeSession()
  const taskLifecycle = useRuntimeTaskLifecycle(currentRuntimeTask)
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
        {taskLifecycle?.derived.isRunning ? 'running' : 'idle'}
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
      <button type="button" onClick={() => void paneSession.resumeCurrentGoal()}>
        resume runtime goal
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
  const gptModel = workbench.projectChat.models.find(model => model.name === 'gpt-5.5')
  const backgroundTaskModel = workbench.projectChat.resolveRuntimeTaskModelSelection({
    deviceId: 'device-1',
    workspacePath: '/workspace/project-alpha',
    taskId: 'runtime-a',
  })

  return (
    <div>
      <span data-testid="selected-model">{workbench.projectChat.selectedModel?.name ?? ''}</span>
      <span data-testid="active-model">{workbench.projectChat.activeModel?.name ?? ''}</span>
      <span data-testid="background-task-selected-model">
        {backgroundTaskModel.selectedModel?.name ?? ''}
      </span>
      <span data-testid="background-task-active-model">
        {backgroundTaskModel.activeModel?.name ?? ''}
      </span>
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
        data-testid="select-gpt-model"
        onClick={() => {
          if (gptModel) workbench.projectChat.setSelectedModel(gptModel)
        }}
      >
        select gpt
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
  const busyResumeQueuedMessagesWithInputRef = useRef(paneSession.resumeQueuedMessagesWithInput)
  const idleSendRef = useRef(paneSession.send)
  useEffect(() => {
    if (paneSession.status.isBusy) {
      busyResumeQueuedMessagesWithInputRef.current = paneSession.resumeQueuedMessagesWithInput
    }
  }, [paneSession.resumeQueuedMessagesWithInput, paneSession.status.isBusy])
  const gptModel =
    workbench.projectChat.models.find(model => model.name === 'gpt-5-2025-08-07') ?? null

  return (
    <div>
      <span data-testid="composer-input">{paneSession.input}</span>
      <span data-testid="pane-session-error">{paneSession.error ?? ''}</span>
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
      <span data-testid="queued-messages-paused">
        {paneSession.queuedMessagesPaused ? 'paused' : 'running'}
      </span>
      <span data-testid="queued-notices">
        {paneSession.queuedMessages.map(message => message.notice ?? '').join('|')}
      </span>
      <span data-testid="queued-guidance-acceptance">
        {paneSession.queuedMessages
          .map(message => (message.awaitingGuidanceAcceptance ? 'pending' : 'accepted'))
          .join('|')}
      </span>
      <span data-testid="runtime-attachment-count">{workbench.projectChat.attachments.length}</span>
      <span data-testid="code-comment-context-count">{paneSession.codeCommentContexts.length}</span>
      <span data-testid="browser-annotation-command">
        {paneSession.browserAnnotationCommand
          ? `${paneSession.browserAnnotationCommand.sequence}:${paneSession.browserAnnotationCommand.reason}`
          : 'none'}
      </span>
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
      <button
        data-testid="follow-up-add-browser-annotation"
        type="button"
        onClick={() =>
          paneSession.addCodeComment({
            id: 'browser-annotation-1',
            source: 'browser_annotation',
            filePath: 'browser:https://example.com/page',
            fileName: 'Example page',
            startLine: 1,
            endLine: 1,
            selectedText: 'Submit button',
            comment: 'Use a clearer label',
            createdAt: '2026-08-13T00:00:00.000Z',
          })
        }
      >
        add browser annotation
      </button>
      <button type="button" onClick={paneSession.clearCodeComments}>
        clear code comments
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
        data-testid="capture-idle-follow-up-send"
        type="button"
        onClick={() => {
          idleSendRef.current = paneSession.send
        }}
      >
        capture idle follow-up send
      </button>
      <button
        type="button"
        onClick={() => void busyResumeQueuedMessagesWithInputRef.current('手动消息')}
      >
        resume queue with manual input
      </button>
      <button
        type="button"
        onClick={() => void idleSendRef.current(undefined, { guideWhenBusy: true })}
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

function ExternalRuntimeSendProbe() {
  const workbench = useWorkbench()

  return (
    <button
      type="button"
      onClick={() => {
        const optimisticUserMessage = createRuntimeUserMessage('修复 PR #2631')
        void workbench.sendRuntimePaneMessage(
          {
            address: {
              deviceId: 'device-1',
              workspacePath: '/workspace/project-alpha',
              taskId: 'runtime-a',
            },
            message: optimisticUserMessage.content,
          },
          { optimisticUserMessage }
        )
      }}
    >
      repair pull request
    </button>
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
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
    vi.useRealTimers()
    delete window.__WEWORK_RUNTIME_CONFIG__
    clearElectronRuntime()
    window.history.pushState({}, '', '/')
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
    resetLocalRuntimeChatStreamsForTests()
    resetComposerAppsMemory()
    pluginApiMocks.cloudListInstalledPlugins.mockResolvedValue({ items: [] })
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
    setElectronRuntime()
    window.__WEWORK_RUNTIME_CONFIG__ = {
      desktopHost: 'electron',
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

  test('opens a forked task before refreshing the runtime task list', async () => {
    const refreshRequest = deferred<RuntimeWorkListResponse>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockResolvedValueOnce(createRuntimeWork())
        .mockReturnValueOnce(refreshRequest.promise),
      forkRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        target: {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          taskId: 'runtime-fork',
        },
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeTaskForkProbe />, services)

    await userEvent.click(await screen.findByTestId('open-fork-source'))
    await waitFor(() =>
      expect(screen.getByTestId('fork-current-runtime-task')).toHaveTextContent('runtime-a')
    )
    expect(screen.getByTestId('fork-current-project')).toHaveTextContent('7')

    await userEvent.click(screen.getByTestId('fork-current-runtime-task-action'))

    await waitFor(() =>
      expect(screen.getByTestId('fork-current-runtime-task')).toHaveTextContent('runtime-fork')
    )
    expect(screen.getByTestId('fork-current-project')).toHaveTextContent('7')
    expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(2)

    refreshRequest.resolve(
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
                    taskId: 'runtime-fork',
                    workspacePath: '/workspace/project-alpha',
                    title: 'Runtime fork',
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
    )
    await waitFor(() => expect(screen.getByTestId('fork-current-project')).toHaveTextContent('7'))
  })

  test('keeps a project task globally pinned while executor refresh is stale', async () => {
    const pinRequest = deferred<void>()
    const runtimeWork = createRuntimeWork({
      projects: [
        {
          project: {
            key: 'local:/workspace/project-alpha',
            name: 'Wegent',
            stateDeviceId: 'state-device',
          },
          deviceWorkspaces: [
            {
              deviceId: 'device-1',
              workspacePath: '/workspace/project-alpha',
              available: true,
              tasks: [
                {
                  taskId: 'runtime-a',
                  threadId: 'thread-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Pinned automation target',
                  runtime: 'codex',
                  pinned: false,
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
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(runtimeWork),
      setRuntimeTaskPinned: vi.fn(() => pinRequest.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeTaskPinProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-pin-state')).toHaveTextContent('unpinned')
    )
    await userEvent.click(screen.getByTestId('pin-runtime-task'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-pin-state')).toHaveTextContent('pinned')
    )
    expect(screen.getByTestId('automation-task-options')).toHaveTextContent('runtime-a')

    await act(async () => {
      pinRequest.resolve()
      await pinRequest.promise
    })
    await waitFor(() => expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('runtime-task-pin-state')).toHaveTextContent('pinned')
    expect(screen.getByTestId('automation-task-options')).toHaveTextContent('runtime-a')
  })

  test('pins a task exposed by refresh before the rendered runtime-work ref synchronizes', async () => {
    const pinRequest = deferred<void>()
    const refreshedRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: {
            key: 'local:/workspace/project-alpha',
            name: 'Wegent',
            stateDeviceId: 'state-device',
          },
          deviceWorkspaces: [
            {
              deviceId: 'device-1',
              workspacePath: '/workspace/project-alpha',
              available: true,
              tasks: [
                {
                  taskId: 'runtime-a',
                  threadId: 'thread-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Fresh automation target',
                  runtime: 'codex',
                  pinned: false,
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
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockResolvedValueOnce(createRuntimeWork({ projects: [], chats: [], totalTasks: 0 }))
        .mockResolvedValue(refreshedRuntimeWork),
      setRuntimeTaskPinned: vi.fn(() => pinRequest.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeTaskPinDuringRefreshProbe />, services)

    await waitFor(() => expect(screen.getByTestId('refresh-runtime-work')).toBeInTheDocument())
    await userEvent.click(screen.getByTestId('refresh-runtime-work'))

    await waitFor(() => expect(runtimeWorkApi.setRuntimeTaskPinned).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('runtime-task-pin-state')).toHaveTextContent('pinned')
    expect(screen.getByTestId('automation-task-options')).toHaveTextContent('runtime-a')

    await act(async () => {
      pinRequest.resolve()
      await pinRequest.promise
    })
  })

  test('rolls back a project task pin when executor persistence fails', async () => {
    const pinRequest = deferred<void>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: {
                key: 'local:/workspace/project-alpha',
                name: 'Wegent',
                stateDeviceId: 'state-device',
              },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  workspacePath: '/workspace/project-alpha',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      threadId: 'thread-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Pinned automation target',
                      runtime: 'codex',
                      pinned: false,
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
      ),
      setRuntimeTaskPinned: vi.fn(() => pinRequest.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeTaskPinProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-pin-state')).toHaveTextContent('unpinned')
    )
    await userEvent.click(screen.getByTestId('pin-runtime-task'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-pin-state')).toHaveTextContent('pinned')
    )

    await act(async () => {
      pinRequest.reject(new Error('pin failed'))
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-pin-error')).toHaveTextContent('failed')
    )
    expect(screen.getByTestId('runtime-task-pin-state')).toHaveTextContent('unpinned')
    expect(screen.getByTestId('automation-task-options')).toHaveTextContent('none')
  })

  test('serializes repeated task pin mutations before applying their optimistic state', async () => {
    const pinRequest = deferred<void>()
    const unpinRequest = deferred<void>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: {
                key: 'local:/workspace/project-alpha',
                name: 'Wegent',
                stateDeviceId: 'state-device',
              },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  workspacePath: '/workspace/project-alpha',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      threadId: 'thread-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Pinned automation target',
                      runtime: 'codex',
                      pinned: false,
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
      ),
      setRuntimeTaskPinned: vi
        .fn()
        .mockReturnValueOnce(pinRequest.promise)
        .mockReturnValueOnce(unpinRequest.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeTaskPinProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-pin-state')).toHaveTextContent('unpinned')
    )
    await userEvent.click(screen.getByTestId('pin-runtime-task'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-pin-state')).toHaveTextContent('pinned')
    )
    await userEvent.click(screen.getByTestId('unpin-runtime-task'))

    expect(runtimeWorkApi.setRuntimeTaskPinned).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('runtime-task-pin-state')).toHaveTextContent('pinned')

    await act(async () => {
      pinRequest.reject(new Error('pin failed'))
      await Promise.resolve()
    })
    await waitFor(() => expect(runtimeWorkApi.setRuntimeTaskPinned).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('runtime-task-pin-state')).toHaveTextContent('unpinned')

    await act(async () => {
      unpinRequest.reject(new Error('unpin failed'))
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-pin-error')).toHaveTextContent('failed')
    )
    expect(screen.getByTestId('runtime-task-pin-state')).toHaveTextContent('unpinned')
    expect(screen.getByTestId('automation-task-options')).toHaveTextContent('none')
  })

  test('does not let workbench providers own shared turn lifecycle events', async () => {
    const lifecycleStore = new RuntimeTaskLifecycleStore('test')
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  workspacePath: '/workspace/project-alpha',
                  available: true,
                  tasks: [
                    {
                      taskId: 'shared-task',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Stale hidden projection',
                      runtime: 'claude_code',
                      running: true,
                      status: 'active',
                    },
                  ],
                },
              ],
            },
          ],
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    const { rerender } = render(
      <WorkbenchProvider
        lifecycleStore={lifecycleStore}
        services={services}
        syncRuntimeTaskLifecycle={false}
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
      >
        <BootstrapProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalled())
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())
    act(() => {
      streamHandlers.onChatStart?.({
        taskId: 'shared-task',
        subtaskId: 'hidden-turn',
        shellType: 'ClaudeCode',
        deviceId: 'device-1',
      })
      streamHandlers.onRuntimeGoalUpdated?.({
        taskId: 'shared-task',
        subtaskId: 'hidden-turn',
        deviceId: 'device-1',
        goal: createRuntimeGoal({
          objective: 'Hidden provider must not own lifecycle writes',
          status: 'active',
        }),
      })
    })
    expect(
      lifecycleStore.getTask({
        deviceId: 'device-1',
        taskId: 'shared-task',
      })
    ).toBeNull()
    const runtimeSubscriptionCount = subscribe.mock.calls.filter(([handlers]) =>
      hasRuntimeStreamHandler(handlers)
    ).length

    rerender(
      <WorkbenchProvider
        lifecycleStore={lifecycleStore}
        services={services}
        syncRuntimeTaskLifecycle
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
      >
        <BootstrapProbe />
      </WorkbenchProvider>
    )

    expect(
      lifecycleStore.getTask({
        deviceId: 'device-1',
        taskId: 'shared-task',
      })
    ).toBeNull()
    expect(
      subscribe.mock.calls.filter(([handlers]) => hasRuntimeStreamHandler(handlers))
    ).toHaveLength(runtimeSubscriptionCount + 1)

    act(() => {
      streamHandlers.onChatStart?.({
        taskId: 'shared-task',
        subtaskId: 'owned-turn',
        shellType: 'ClaudeCode',
        deviceId: 'device-1',
      })
    })
    expect(
      lifecycleStore.getTask({
        deviceId: 'device-1',
        taskId: 'shared-task',
      })
    ).toBeNull()
  })

  test('keeps the runtime event subscription across connected user preference updates', async () => {
    setElectronRuntime()
    window.__WEWORK_RUNTIME_CONFIG__ = {
      desktopHost: 'electron',
      runtimeMode: 'local-first',
    }
    const user = {
      id: 1,
      user_name: 'alice',
      email: 'a@b.c',
      preferences: { send_key: 'enter' as const },
    }
    const cloudConnectionValue = (connectedUser: User): CloudConnectionContextValue => ({
      ...DISCONNECTED_STATE,
      isConnected: false,
      serviceKey: 'test-disconnected',
      user: connectedUser,
      connectWithAuthorization: vi.fn(),
      refreshUser: vi.fn(),
      disconnect: vi.fn(),
    })
    const renderTree = (connectedUser: User) => (
      <CloudConnectionContext.Provider value={cloudConnectionValue(connectedUser)}>
        <WorkbenchProvider user={LOCAL_USER}>
          <WorkbenchProbeSessionProvider>
            <BootstrapProbe />
          </WorkbenchProbeSessionProvider>
        </WorkbenchProvider>
      </CloudConnectionContext.Provider>
    )
    const rendered = render(renderTree(user))

    await waitFor(() => expect(localExecutorMocks.subscribeLocalExecutorEvents).toHaveBeenCalled())
    const subscriptionCount = localExecutorMocks.subscribeLocalExecutorEvents.mock.calls.length

    rendered.rerender(
      renderTree({
        ...user,
        preferences: { send_key: 'cmd_enter' },
      })
    )

    await waitFor(() => expect(screen.getByTestId('boot-state')).toHaveTextContent('alice'))
    expect(localExecutorMocks.subscribeLocalExecutorEvents).toHaveBeenCalledTimes(subscriptionCount)
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

  test('warms Codex composer apps once during workbench startup', async () => {
    setElectronRuntime()
    localExecutorMocks.requestLocalExecutor.mockImplementation(
      async (method: string, params?: unknown) => {
        if (method === 'runtime.tasks.list') {
          return { projects: [], chats: [], totalTasks: 0 }
        }
        if (method === 'codex.app_server_request') {
          const request = params as { method?: string }
          if (request.method === 'plugin/installed') {
            return { marketplaces: [] }
          }
          if (request.method === 'app/list') {
            return { data: [], nextCursor: null }
          }
        }
        return {}
      }
    )

    renderStrictWorkbench(<BootstrapProbe />)

    await waitFor(() => expect(screen.getByTestId('startup-ready')).toHaveTextContent('ready'))
    await waitFor(() =>
      expect(
        localExecutorMocks.requestLocalExecutor.mock.calls.filter(
          ([method, params]) =>
            method === 'codex.app_server_request' &&
            (params as { method?: string }).method === 'app/list'
        )
      ).toHaveLength(1)
    )
    expect(
      localExecutorMocks.requestLocalExecutor.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          (params as { method?: string }).method === 'app/list'
      )
    ).toHaveLength(1)
  })

  test('allows retained non-composer workbenches to skip Codex app prewarming', async () => {
    setElectronRuntime()
    localExecutorMocks.requestLocalExecutor.mockImplementation(
      async (method: string, params?: unknown) => {
        if (method === 'runtime.tasks.list') {
          return { projects: [], chats: [], totalTasks: 0 }
        }
        if (method === 'codex.app_server_request') {
          const request = params as { method?: string }
          if (request.method === 'plugin/installed') {
            return { marketplaces: [] }
          }
          if (request.method === 'app/list') {
            return { data: [], nextCursor: null }
          }
        }
        return {}
      }
    )

    render(
      <StrictMode>
        <WorkbenchProvider
          user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
          services={createWorkbenchServices()}
          prewarmComposerApps={false}
        >
          <BootstrapProbe />
        </WorkbenchProvider>
      </StrictMode>
    )

    await waitFor(() => expect(screen.getByTestId('startup-ready')).toHaveTextContent('ready'))
    expect(
      localExecutorMocks.requestLocalExecutor.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          (params as { method?: string }).method === 'app/list'
      )
    ).toHaveLength(0)
  })

  test('keeps project-space providers ready without loading task composer catalogs', async () => {
    const services = createWorkbenchServices()
    const user = userEvent.setup()

    render(
      <StrictMode>
        <WorkbenchProvider
          user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
          services={services}
          loadTaskComposerCatalogs={false}
          prewarmComposerApps={false}
        >
          <BootstrapProbe />
        </WorkbenchProvider>
      </StrictMode>
    )

    await waitFor(() => expect(screen.getByTestId('startup-ready')).toHaveTextContent('ready'))
    expect(services.modelApi.listModels).not.toHaveBeenCalled()
    expect(services.skillApi.listSkills).not.toHaveBeenCalled()
    expect(services.skillApi.getTeamSkills).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Load task composer catalogs' }))

    await waitFor(() => expect(services.modelApi.listModels).toHaveBeenCalled())
    await waitFor(() => expect(services.skillApi.listSkills).toHaveBeenCalled())
    expect(services.skillApi.getTeamSkills).not.toHaveBeenCalled()
  })

  test('does not let a stale bootstrap runtime request overwrite a manual refresh', async () => {
    const bootstrapRuntimeWork = deferred<RuntimeWorkListResponse>()
    const manualRuntimeWork = createRuntimeWork({
      projects: [],
      chats: [],
      totalTasks: 4,
    })
    const listRuntimeWork = vi
      .fn()
      .mockImplementationOnce(() => bootstrapRuntimeWork.promise)
      .mockResolvedValueOnce(manualRuntimeWork)
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({ listRuntimeWork }),
    })

    renderWorkbench(<BootstrapProbe />, services)
    await waitFor(() => expect(listRuntimeWork).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByRole('button', { name: 'Refresh work lists' }))
    await waitFor(() => expect(screen.getByTestId('runtime-total')).toHaveTextContent('4'))

    bootstrapRuntimeWork.resolve(createRuntimeWork({ projects: [], chats: [], totalTasks: 1 }))
    await act(async () => {
      await bootstrapRuntimeWork.promise
    })

    expect(screen.getByTestId('runtime-total')).toHaveTextContent('4')
  })

  test('clears composer plugin apps after plugin state refresh returns no current-device installs', async () => {
    setElectronRuntime()
    localExecutorMocks.requestLocalExecutor.mockImplementation(
      async (method: string, params?: unknown) => {
        if (method === 'runtime.tasks.list') {
          return { projects: [], chats: [], totalTasks: 0 }
        }
        if (method === 'codex.app_server_request') {
          const request = params as { method?: string }
          if (request.method === 'plugin/list' || request.method === 'plugin/installed') {
            return { marketplaces: [] }
          }
          if (request.method === 'app/list') {
            return { data: [], nextCursor: null }
          }
        }
        return {}
      }
    )
    const documentsPlugin: InstalledPlugin = {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'InstalledPlugin',
      metadata: { name: 'documents', namespace: 'default', labels: { id: '101' } },
      spec: {
        source: {
          type: 'marketplace',
          providerKey: 'wegent-market',
          pluginKey: 'documents',
        },
        displayName: 'Documents',
        description: 'Create documents',
        installState: 'installed',
        enabled: true,
        visibility: 'public',
        pluginId: 101,
        releaseId: 1001,
        manifest: { name: 'documents' },
        components: {
          skills: [],
          commands: [],
          apps: [],
          agents: [],
          hooks: [],
          mcps: [],
          lsps: [],
          monitors: [],
          bins: [],
        },
        interface: { shortDescription: 'Create documents' },
      },
      status: { state: 'enabled' },
    }
    pluginApiMocks.cloudListInstalledPlugins
      .mockResolvedValueOnce({ items: [documentsPlugin] })
      .mockResolvedValue({ items: [] })

    renderWorkbench(<RuntimeTaskSkillsProbe />)

    await userEvent.click(screen.getByText('list local apps'))
    await waitFor(() => expect(getComposerApps().map(app => app.id)).toContain('plugin:documents'))
    expect(pluginApiMocks.cloudListInstalledPlugins).toHaveBeenCalledWith('local-device')

    act(() => {
      window.dispatchEvent(new Event(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT))
    })

    await waitFor(() => expect(getComposerApps()).toEqual([]))
  })

  test('coalesces repeated local plugin change events into one composer refresh', async () => {
    setElectronRuntime()
    localExecutorMocks.requestLocalExecutor.mockImplementation(
      async (method: string, params?: unknown) => {
        if (method === 'runtime.tasks.list') {
          return { projects: [], chats: [], totalTasks: 0 }
        }
        if (method === 'codex.app_server_request') {
          const request = params as { method?: string }
          if (request.method === 'plugin/installed') {
            return { marketplaces: [] }
          }
          if (request.method === 'app/list') {
            return { data: [], nextCursor: null }
          }
        }
        return {}
      }
    )

    renderWorkbench(<RuntimeTaskSkillsProbe />)

    await userEvent.click(screen.getByText('list local apps'))
    await waitFor(() =>
      expect(
        localExecutorMocks.requestLocalExecutor.mock.calls.some(
          ([method, params]) =>
            method === 'codex.app_server_request' &&
            (params as { method?: string }).method === 'plugin/installed'
        )
      ).toBe(true)
    )
    await new Promise(resolve => window.setTimeout(resolve, 300))
    localExecutorMocks.requestLocalExecutor.mockClear()

    act(() => {
      window.dispatchEvent(new Event(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT))
      window.dispatchEvent(new Event(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT))
      window.dispatchEvent(new Event(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT))
    })

    const pluginInstalledRequestCount = () =>
      localExecutorMocks.requestLocalExecutor.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          (params as { method?: string }).method === 'plugin/installed'
      ).length
    await waitFor(() => expect(pluginInstalledRequestCount()).toBe(2))
    await new Promise(resolve => window.setTimeout(resolve, 300))
    expect(pluginInstalledRequestCount()).toBe(2)
  })

  test('ignores a superseded project plugin load after switching projects', async () => {
    const alphaLoad = deferred<{ marketplaces: unknown[] }>()
    let pluginLoadScope: 'alpha' | 'beta' = 'alpha'
    const installedMarketplace = {
      name: 'team-market',
      path: '/tmp/team-market',
      interface: { displayName: 'Team Market' },
      plugins: [
        {
          name: 'alpha-plugin',
          id: 'alpha-plugin',
          installed: true,
          enabled: false,
          interface: { displayName: 'Alpha Plugin' },
        },
        {
          name: 'beta-plugin',
          id: 'beta-plugin',
          installed: true,
          enabled: false,
          interface: { displayName: 'Beta Plugin' },
        },
      ],
    }
    localExecutorMocks.requestLocalExecutor.mockImplementation(
      async (method: string, params?: unknown) => {
        if (method === 'runtime.tasks.list') {
          return { projects: [], chats: [], totalTasks: 0 }
        }
        if (method === 'codex.app_server_request') {
          const request = params as { method?: string }
          if (request.method === 'app/list') {
            return { data: [], nextCursor: null }
          }
          if (request.method === 'plugin/installed') {
            if (pluginLoadScope === 'alpha') return alphaLoad.promise
            return { marketplaces: [installedMarketplace] }
          }
        }
        return {}
      }
    )
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: {
                id: 7,
                key: 'project:7',
                name: 'Alpha',
                source: 'local_project',
                aiSettings: {
                  plugins: [
                    {
                      id: 'alpha-plugin@team-market',
                      pluginName: 'alpha-plugin',
                      marketplaceId: 'team-market',
                      displayName: 'Alpha Plugin',
                    },
                  ],
                },
              },
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
              project: {
                id: 8,
                key: 'project:8',
                name: 'Beta',
                source: 'local_project',
                aiSettings: {
                  plugins: [
                    {
                      id: 'beta-plugin@team-market',
                      pluginName: 'beta-plugin',
                      marketplaceId: 'team-market',
                      displayName: 'Beta Plugin',
                    },
                  ],
                },
              },
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

    renderWorkbench(<ProjectWorkPreferenceProbe />, services)

    await screen.findByText('select project 7 workspace 22')
    setElectronRuntime()
    await userEvent.click(screen.getByText('select project 7 workspace 22'))
    await waitFor(() =>
      expect(
        localExecutorMocks.requestLocalExecutor.mock.calls.some(
          ([method, params]) =>
            method === 'codex.app_server_request' &&
            (params as { method?: string }).method === 'plugin/installed'
        )
      ).toBe(true)
    )

    pluginLoadScope = 'beta'
    await userEvent.click(screen.getByText('select project 8'))

    await waitFor(() =>
      expect(getComposerApps().map(app => app.id)).toEqual(['plugin:beta-plugin'])
    )

    alphaLoad.resolve({ marketplaces: [installedMarketplace] })
    await act(async () => {
      await alphaLoad.promise
      await Promise.resolve()
    })

    expect(getComposerApps().map(app => app.id)).toEqual(['plugin:beta-plugin'])
  })

  test('settles a background runtime task after the executor reports idle', async () => {
    let backgroundStreamHandlers: ChatStreamHandlers | null = null
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) {
        backgroundStreamHandlers = handlers
      }
      return vi.fn()
    })
    let executorRunning = true
    const listRuntimeWork = vi.fn().mockImplementation(() =>
      Promise.resolve(
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
                      running: executorRunning,
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
          ],
          totalTasks: 1,
        })
      )
    )
    const runtimeWorkApi = createRuntimeWorkApiMock({ listRuntimeWork })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimeRunningTasksProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-running-task-ids')).toHaveTextContent('runtime-a')
    )
    await waitFor(() => expect(backgroundStreamHandlers?.onChatDone).toBeDefined())

    executorRunning = false
    await act(async () => {
      backgroundStreamHandlers?.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: 'goal-final',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-running-task-ids')).toHaveTextContent('none')
    )
    expect(listRuntimeWork).toHaveBeenCalledTimes(2)
  })

  test('settles guidance applied while its runtime pane is in the background', async () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-a',
      workspacePath: '/workspace/project-alpha',
    }
    let backgroundStreamHandlers: ChatStreamHandlers | null = null
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) {
        backgroundStreamHandlers = handlers
      }
      return vi.fn()
    })
    const runtimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: address.deviceId,
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: address.workspacePath ?? '',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: address.taskId,
                  workspacePath: address.workspacePath ?? '',
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
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(runtimeWork),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })
    cacheRuntimeConversationQueuedMessages(address, [
      {
        id: 'client-guidance-1',
        content: '继续检查后台任务',
        status: 'sending',
        deliveryMode: 'guidance',
        notice: '正在引导当前对话',
        createdAt: '2026-07-27T00:00:00.000Z',
      },
    ])
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'turn-1',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      itemId: 'assistant-item-1',
      content: '正在检查',
    })

    renderWorkbench(<RuntimeRunningTasksProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-running-task-ids')).toHaveTextContent(address.taskId)
    )
    await waitFor(() => expect(backgroundStreamHandlers?.onGuidanceApplied).toBeDefined())

    act(() => {
      backgroundStreamHandlers?.onGuidanceApplied?.({
        taskId: address.taskId,
        deviceId: address.deviceId,
        subtaskId: 'turn-1',
        guidanceId: 'client-guidance-1',
        clientGuidanceId: 'client-guidance-1',
        message: '继续检查后台任务',
        appliedAtMs: Date.now(),
      })
    })

    expect(getRuntimeConversationQueuedMessages(address)).toEqual([])
    expect(getRuntimeConversationMessages(address).map(message => message.content)).toEqual([
      '正在检查',
      '继续检查后台任务',
      '',
    ])
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
    setElectronRuntime()
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
    setElectronRuntime()
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

  test('keeps available status during refresh and becomes unavailable when backend reads fail', async () => {
    const teamsRefresh = deferred<Team[]>()
    const devicesRefresh = deferred<DeviceInfo[]>()
    const runtimeWorkRefresh = deferred<RuntimeWorkListResponse>()
    const services = createWorkbenchServices({
      cloudBackgroundApi: {
        listTeams: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockImplementationOnce(() => teamsRefresh.promise),
        listDevices: vi
          .fn()
          .mockResolvedValueOnce([
            createDevice({ device_id: 'remote-device', device_type: 'remote', is_default: false }),
          ])
          .mockImplementationOnce(() => devicesRefresh.promise),
        listRuntimeWork: vi
          .fn()
          .mockResolvedValueOnce({ projects: [], chats: [], totalTasks: 0 })
          .mockImplementationOnce(() => runtimeWorkRefresh.promise),
      },
    })

    renderWorkbench(
      <>
        <CloudWorkStatusProbe />
        <BootstrapProbe />
      </>,
      services
    )

    await waitFor(() =>
      expect(screen.getByTestId('cloud-work-availability')).toHaveTextContent('available')
    )

    await userEvent.click(screen.getByRole('button', { name: 'Refresh devices' }))
    expect(screen.getByTestId('cloud-work-availability')).toHaveTextContent('available')

    await act(async () => {
      teamsRefresh.reject(new Error('backend unavailable'))
      devicesRefresh.reject(new Error('backend unavailable'))
      runtimeWorkRefresh.reject(new Error('backend unavailable'))
    })

    await waitFor(() =>
      expect(screen.getByTestId('cloud-work-availability')).toHaveTextContent('unavailable')
    )
    expect(screen.getByTestId('cloud-work-error')).toHaveTextContent('backend unavailable')
  })

  test('keeps unavailable status during refresh and becomes available after backend recovery', async () => {
    const teamsRefresh = deferred<Team[]>()
    const devicesRefresh = deferred<DeviceInfo[]>()
    const runtimeWorkRefresh = deferred<RuntimeWorkListResponse>()
    const services = createWorkbenchServices({
      cloudBackgroundApi: {
        listTeams: vi
          .fn()
          .mockRejectedValueOnce(new Error('backend unavailable'))
          .mockImplementationOnce(() => teamsRefresh.promise),
        listDevices: vi
          .fn()
          .mockRejectedValueOnce(new Error('backend unavailable'))
          .mockImplementationOnce(() => devicesRefresh.promise),
        listRuntimeWork: vi
          .fn()
          .mockRejectedValueOnce(new Error('backend unavailable'))
          .mockImplementationOnce(() => runtimeWorkRefresh.promise),
      },
    })

    renderWorkbench(
      <>
        <CloudWorkStatusProbe />
        <BootstrapProbe />
      </>,
      services
    )

    await waitFor(() =>
      expect(screen.getByTestId('cloud-work-availability')).toHaveTextContent('unavailable')
    )

    await userEvent.click(screen.getByRole('button', { name: 'Refresh devices' }))
    expect(screen.getByTestId('cloud-work-availability')).toHaveTextContent('unavailable')

    await act(async () => {
      teamsRefresh.resolve([])
      devicesRefresh.resolve([
        createDevice({ device_id: 'remote-device', device_type: 'remote', is_default: false }),
      ])
      runtimeWorkRefresh.resolve({ projects: [], chats: [], totalTasks: 0 })
    })

    await waitFor(() =>
      expect(screen.getByTestId('cloud-work-availability')).toHaveTextContent('available')
    )
    expect(screen.getByTestId('cloud-work-error')).toHaveTextContent('')
  })

  test('publishes cloud devices before a slow runtime-work refresh completes', async () => {
    const runtimeWork = deferred<RuntimeWorkListResponse>()
    let runtimeWorkResolved = false
    void runtimeWork.promise.then(() => {
      runtimeWorkResolved = true
    })
    const services = createWorkbenchServices({
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi
          .fn()
          .mockResolvedValue([
            createDevice({ device_id: 'remote-device', device_type: 'remote', is_default: false }),
          ]),
        listRuntimeWork: vi.fn(() => runtimeWork.promise),
      },
    })

    renderWorkbench(<BootstrapProbe />, services)

    await waitFor(() => expect(screen.getByTestId('device-ids')).toHaveTextContent('remote-device'))
    expect(runtimeWorkResolved).toBe(false)

    await act(async () => {
      runtimeWork.resolve({ projects: [], chats: [], totalTasks: 0 })
    })
  })

  afterEach(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  test('does not let a stale cloud refresh remove a newer local runtime task', async () => {
    const cloudRuntimeWork = deferred<RuntimeWorkListResponse>()
    const emptyRuntimeWork = createRuntimeWork({
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
                  taskId: 'runtime-new-local',
                  workspacePath: '/workspace/project-alpha',
                  title: 'New local task',
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
    const listRuntimeWork = vi
      .fn()
      .mockResolvedValueOnce(emptyRuntimeWork)
      .mockResolvedValue(refreshedRuntimeWork)
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({ listRuntimeWork }),
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([]),
        listRuntimeWork: vi.fn(() => cloudRuntimeWork.promise),
      },
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(listRuntimeWork).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByText('refresh work lists'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-titles')).toHaveTextContent('New local task')
    )

    await act(async () => {
      cloudRuntimeWork.resolve({ projects: [], chats: [], totalTasks: 0 })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-titles')).toHaveTextContent('New local task')
    )
  })

  test('does not let an older work-list refresh erase a queued task status', async () => {
    const staleRefresh = deferred<RuntimeWorkListResponse>()
    const latestRefresh = deferred<RuntimeWorkListResponse>()
    const runtimeWorkWithStatus = (status: 'active' | 'queued', queuePosition?: number) =>
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
                    taskId: 'runtime-queued',
                    workspacePath: '/workspace/project-alpha',
                    title: 'Queued task',
                    runtime: 'codex',
                    running: false,
                    status,
                    queuePosition,
                  },
                ],
              },
            ],
            totalTasks: 1,
          },
        ],
        totalTasks: 1,
      })
    const queuedRuntimeWork = runtimeWorkWithStatus('queued', 1)
    const listRuntimeWork = vi
      .fn()
      .mockResolvedValueOnce(queuedRuntimeWork)
      .mockImplementationOnce(() => staleRefresh.promise)
      .mockImplementationOnce(() => latestRefresh.promise)
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({ listRuntimeWork }),
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-statuses')).toHaveTextContent('queued')
    )
    await userEvent.click(screen.getByText('refresh work lists'))
    await userEvent.click(screen.getByText('refresh work lists'))

    await act(async () => {
      latestRefresh.resolve(queuedRuntimeWork)
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-statuses')).toHaveTextContent('queued')
    )

    await act(async () => {
      staleRefresh.resolve(runtimeWorkWithStatus('active'))
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-statuses')).toHaveTextContent('queued')
    )
  })

  test('does not let a stale cloud refresh roll back a generated runtime task title', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const cloudRuntimeWork = deferred<RuntimeWorkListResponse>()
    const localRuntimeWork = createRuntimeWork({
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
                  title: '解决冲突',
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
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({
        listRuntimeWork: vi.fn().mockResolvedValue(localRuntimeWork),
      }),
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([]),
        listRuntimeWork: vi.fn(() => cloudRuntimeWork.promise),
      },
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-titles')).toHaveTextContent('解决冲突')
    )
    await waitFor(() => expect(streamHandlers.onRuntimeTaskTitleUpdated).toBeDefined())

    act(() => {
      streamHandlers.onRuntimeTaskTitleUpdated?.({
        taskId: 'runtime-a',
        subtaskId: 'friendly-title',
        deviceId: 'device-1',
        title: '解决分支冲突',
      })
    })
    expect(screen.getByTestId('runtime-task-titles')).toHaveTextContent('解决分支冲突')

    await act(async () => {
      cloudRuntimeWork.resolve(localRuntimeWork)
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-titles')).toHaveTextContent('解决分支冲突')
    )
    expect(screen.getByTestId('runtime-task-titles')).not.toHaveTextContent('解决冲突')
  })

  test('cancels an in-flight cloud sync before a manual device refresh', async () => {
    const runtimeWork = deferred<RuntimeWorkListResponse>()
    const manualDevices = deferred<DeviceInfo[]>()
    const runtimeSignals: AbortSignal[] = []
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce([
        createDevice({ device_id: 'current-device', device_type: 'remote', is_default: false }),
      ])
      .mockImplementationOnce(() => manualDevices.promise)
    const listRuntimeWork = vi.fn((requestOptions?: { signal?: AbortSignal }) => {
      if (requestOptions?.signal) runtimeSignals.push(requestOptions.signal)
      return runtimeWork.promise
    })
    const services = createWorkbenchServices({
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices,
        listRuntimeWork,
      },
    })

    renderWorkbench(<BootstrapProbe />, services)
    await waitFor(() =>
      expect(screen.getByTestId('device-ids')).toHaveTextContent('current-device')
    )

    await userEvent.click(screen.getByRole('button', { name: 'Refresh devices' }))
    await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2))
    expect(runtimeSignals[0]?.aborted).toBe(true)
    expect(runtimeSignals[1]?.aborted).toBe(false)
    await act(async () => {
      runtimeWork.resolve({ projects: [], chats: [], totalTasks: 0 })
      await Promise.resolve()
      manualDevices.resolve([
        createDevice({ device_id: 'refreshed-device', device_type: 'remote', is_default: false }),
      ])
    })

    await waitFor(() =>
      expect(screen.getByTestId('device-ids')).toHaveTextContent('refreshed-device')
    )
  })

  test('does not leave cloud work stuck syncing when a sync is superseded', async () => {
    const runtimeWork = deferred<RuntimeWorkListResponse>()
    const services = createWorkbenchServices({
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([]),
        listRuntimeWork: vi.fn(() => runtimeWork.promise),
      },
    })

    renderWorkbench(
      <>
        <CloudWorkStatusProbe />
        <BootstrapProbe />
      </>,
      services
    )

    await waitFor(() =>
      expect(screen.getByTestId('cloud-work-availability')).toHaveTextContent('syncing')
    )

    await userEvent.click(screen.getByRole('button', { name: 'Refresh devices' }))
    await act(async () => {
      runtimeWork.resolve({ projects: [], chats: [], totalTasks: 0 })
      await runtimeWork.promise
    })

    await waitFor(() =>
      expect(screen.getByTestId('cloud-work-availability')).not.toHaveTextContent('syncing')
    )
  })

  test('does not leave cloud work stuck syncing when a task is archived mid-sync', async () => {
    const runtimeWork = deferred<RuntimeWorkListResponse>()
    const runtimeWorkApi = createRuntimeWorkApiMock()
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([]),
        listRuntimeWork: vi.fn(() => runtimeWork.promise),
      },
    })

    renderWorkbench(
      <>
        <CloudWorkStatusProbe />
        <ArchiveRemoteRuntimeTaskProbe />
      </>,
      services
    )

    await waitFor(() =>
      expect(screen.getByTestId('cloud-work-availability')).toHaveTextContent('syncing')
    )

    await userEvent.click(screen.getByText('archive remote task'))
    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1))

    await waitFor(() =>
      expect(screen.getByTestId('cloud-work-availability')).not.toHaveTextContent('syncing')
    )
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

  test('keeps the last confirmed online state when an offline event refresh fails', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return vi.fn()
    })
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce([createDevice({ status: 'online' })])
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

    await waitFor(() => expect(screen.getByTestId('device-status')).toHaveTextContent('online'))

    await act(async () => {
      streamHandlers.onDeviceOffline?.({ device_id: 'device-1' })
    })

    expect(screen.getByTestId('device-status')).toHaveTextContent('online')
    await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2))
  })

  test('applies an offline state after device discovery confirms it', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return vi.fn()
    })
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce([createDevice({ status: 'online' })])
      .mockResolvedValueOnce([createDevice({ status: 'offline' })])
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices,
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<DeviceStatusProbe />, services)

    await waitFor(() => expect(screen.getByTestId('device-status')).toHaveTextContent('online'))

    await act(async () => {
      streamHandlers.onDeviceOffline?.({ device_id: 'device-1' })
    })

    await waitFor(() => expect(screen.getByTestId('device-status')).toHaveTextContent('offline'))
  })

  test('keeps the last confirmed online state when an offline status event refresh fails', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return vi.fn()
    })
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce([createDevice({ status: 'online' })])
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

    await waitFor(() => expect(screen.getByTestId('device-status')).toHaveTextContent('online'))

    await act(async () => {
      streamHandlers.onDeviceStatus?.({ device_id: 'device-1', status: 'offline' })
    })

    expect(screen.getByTestId('device-status')).toHaveTextContent('online')
    await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2))
  })

  test('applies an offline state after an offline status event is confirmed', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return vi.fn()
    })
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce([createDevice({ status: 'online' })])
      .mockResolvedValueOnce([createDevice({ status: 'offline' })])
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices,
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<DeviceStatusProbe />, services)

    await waitFor(() => expect(screen.getByTestId('device-status')).toHaveTextContent('online'))

    await act(async () => {
      streamHandlers.onDeviceStatus?.({ device_id: 'device-1', status: 'offline' })
    })

    await waitFor(() => expect(screen.getByTestId('device-status')).toHaveTextContent('offline'))
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

  test('disposes the project chat socket while unmounting', () => {
    const projectChatClient = {
      subscribe: vi.fn(),
      send: vi.fn(),
      dispose: vi.fn(),
    }
    const services = createWorkbenchServices({ projectChatClient } as Partial<WorkbenchServices>)

    const { unmount } = renderWorkbench(<BootstrapProbe />, services)
    unmount()

    expect(projectChatClient.dispose).toHaveBeenCalledTimes(1)
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

    await waitFor(() =>
      expect(screen.getByText('select project 7 workspace 22')).toBeInTheDocument()
    )
    await userEvent.click(screen.getByText('select project 7 workspace 22'))

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

    await waitFor(() =>
      expect(screen.getByText('select project 7 workspace 22')).toBeInTheDocument()
    )
    await userEvent.click(screen.getByText('select project 7 workspace 22'))
    await waitFor(() => expect(screen.getByTestId('current-project-id')).toHaveTextContent('7'))
    await userEvent.click(screen.getByText('use worktree'))
    await userEvent.click(screen.getByText('select alpha'))

    await waitFor(() =>
      expect(updateCurrentUser).toHaveBeenLastCalledWith({
        preferences: expect.objectContaining({
          wework_project_work_preferences: expect.objectContaining({
            'project:7:workspace:22': {
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
    await userEvent.click(screen.getByText('select project 7 workspace 22'))

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

  test('restores launch preferences independently for DeviceWorkspaces in one project', async () => {
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
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  available: true,
                  tasks: [],
                },
                {
                  id: 23,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-beta',
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
    const user: User = {
      id: 1,
      user_name: 'alice',
      email: 'a@b.c',
      preferences: {
        wework_project_work_preferences: {
          'project:7': {
            executionMode: 'git_worktree',
            worktreeBranch: 'legacy/shared',
          },
          'project:7:workspace:22': {
            executionMode: 'git_worktree',
            worktreeBranch: 'feature/alpha',
          },
          'project:7:workspace:23': {
            executionMode: 'current_workspace',
            worktreeBranch: 'feature/beta',
          },
        },
      },
    }
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbenchForUser(<ProjectWorkPreferenceProbe />, user, services)

    await userEvent.click(await screen.findByText('select project 7 workspace 22'))
    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('git_worktree')
    )
    expect(screen.getByTestId('project-worktree-branch')).toHaveTextContent('feature/alpha')

    await userEvent.click(screen.getByText('select project 7 workspace 23'))
    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('current_workspace')
    )
    expect(screen.getByTestId('project-worktree-branch')).toHaveTextContent('feature/beta')

    await userEvent.click(screen.getByText('select project 7 workspace 22'))
    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('git_worktree')
    )
    expect(screen.getByTestId('project-worktree-branch')).toHaveTextContent('feature/alpha')
  })

  test('serializes preference saves so an old workspace response cannot overwrite a new one', async () => {
    const firstSave = deferred<unknown>()
    const updateCurrentUser = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValue({})
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
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  available: true,
                  tasks: [],
                },
                {
                  id: 23,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-beta',
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

    await userEvent.click(await screen.findByText('select project 7 workspace 22'))
    await userEvent.click(screen.getByText('use worktree'))
    await waitFor(() => expect(updateCurrentUser).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByText('select project 7 workspace 23'))
    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('current_workspace')
    )
    await userEvent.click(screen.getByText('select beta'))
    expect(updateCurrentUser).toHaveBeenCalledTimes(1)

    firstSave.resolve({})

    await waitFor(() => expect(updateCurrentUser).toHaveBeenCalledTimes(2))
    expect(updateCurrentUser).toHaveBeenLastCalledWith({
      preferences: {
        wework_project_work_preferences: expect.objectContaining({
          'project:7:workspace:22': {
            executionMode: 'git_worktree',
            worktreeBranch: null,
          },
          'project:7:workspace:23': {
            executionMode: 'current_workspace',
            worktreeBranch: 'feature/beta',
          },
        }),
      },
    })
    expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('current_workspace')
    expect(screen.getByTestId('project-worktree-branch')).toHaveTextContent('feature/beta')
  })

  test('localizes a failed launch mode preference save in English', async () => {
    await i18n.changeLanguage('en')
    const updateCurrentUser = vi.fn().mockRejectedValue(new Error('save failed'))
    const services = createWorkbenchServices({
      userApi: {
        updateCurrentUser,
      } as Partial<WorkbenchServices['userApi']> as WorkbenchServices['userApi'],
    })

    renderWorkbench(<ProjectWorkPreferenceProbe />, services)

    await userEvent.click(await screen.findByText('select project 7 workspace 22'))
    await userEvent.click(screen.getByText('use worktree'))

    await waitFor(() =>
      expect(screen.getByTestId('project-work-preference-error')).toHaveTextContent(
        'Failed to save launch mode'
      )
    )
  })

  test('localizes a failed Worktree branch preference save in Chinese', async () => {
    const updateCurrentUser = vi.fn().mockRejectedValue(new Error('save failed'))
    const services = createWorkbenchServices({
      userApi: {
        updateCurrentUser,
      } as Partial<WorkbenchServices['userApi']> as WorkbenchServices['userApi'],
    })

    renderWorkbench(<ProjectWorkPreferenceProbe />, services)

    await userEvent.click(await screen.findByText('select project 7 workspace 22'))
    await userEvent.click(screen.getByText('select alpha'))

    await waitFor(() =>
      expect(screen.getByTestId('project-work-preference-error')).toHaveTextContent(
        '启动分支保存失败'
      )
    )
  })

  test('binds the active runtime model selection with a private IM session', async () => {
    const bindRuntimeTaskImSessions = vi.fn().mockResolvedValue({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      boundSessionKeys: ['session-a'],
      notifiedCount: 1,
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
                      modelSelection: {
                        modelName: 'gpt-5.6-luna',
                        modelType: 'public',
                        options: { reasoningEffort: 'low' },
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
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [],
      }),
      bindRuntimeTaskImSessions,
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'gpt-5.6-luna',
              type: 'public',
              namespace: 'default',
              resourceUserId: 0,
              provider: 'cloud',
            },
          ],
        }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('open project runtime task'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    await userEvent.click(screen.getByText('bind runtime task to IM'))

    await waitFor(() => expect(bindRuntimeTaskImSessions).toHaveBeenCalledTimes(1))
    expect(bindRuntimeTaskImSessions).toHaveBeenCalledWith({
      address: expect.objectContaining({
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      }),
      taskTitle: 'Runtime A',
      sessionKeys: ['session-a'],
      modelSelection: {
        modelName: 'gpt-5.6-luna',
        modelType: 'public',
        options: {
          reasoningEffort: 'low',
          collaborationMode: 'default',
          weworkCloudModelNamespace: 'default',
          weworkCloudModelResourceUserId: '0',
        },
      },
    })
  })

  test('keeps executor-backed model choices selectable inside existing runtime tasks', async () => {
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
          'codex-gpt-5.5:enabled',
          'gpt-5-2025-08-07:enabled',
        ].join('|')
      )
    )
  })

  test('keeps all executor-backed catalog models selectable inside existing Codex runtime tasks', async () => {
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
          'wecode-claude-sonnet-4-5:enabled',
        ].join('|')
      )
    )
  })

  test('keeps GPT and third-party models selectable inside an existing conversation', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'gpt-5.6-sol',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-official',
          ui: { family: 'codex-official' },
        },
      },
      {
        name: 'gpt-5.5',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-official',
          ui: { family: 'codex-official' },
        },
      },
      {
        name: 'kimi-k2.5',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-provider',
          ui: { family: 'codex-provider' },
        },
      },
      {
        name: 'cloud-model',
        type: 'public',
        provider: 'cloud',
        config: {
          ui: { family: 'gpt' },
        },
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
                      modelSelection: {
                        modelName: 'gpt-5.6-sol',
                        modelType: 'runtime',
                        options: {},
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
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelCompatibilityProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-model-compatibility')).toHaveTextContent(
        ['gpt-5.6-sol:enabled', 'gpt-5.5:enabled', 'kimi-k2.5:enabled', 'cloud-model:enabled'].join(
          '|'
        )
      )
    )

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-model-compatibility')).toHaveTextContent(
        ['gpt-5.6-sol:enabled', 'gpt-5.5:enabled', 'kimi-k2.5:enabled', 'cloud-model:enabled'].join(
          '|'
        )
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
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([createDevice({ device_type: 'local' })]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
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

  test('serializes blank new chat model selection saves', async () => {
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
    const firstSave = deferred<unknown>()
    const updateCurrentUser = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValue({})
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([createDevice({ device_type: 'local' })]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
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
    await waitFor(() => expect(updateCurrentUser).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByText('select gpt'))
    expect(updateCurrentUser).toHaveBeenCalledTimes(1)

    firstSave.resolve({})

    await waitFor(() => expect(updateCurrentUser).toHaveBeenCalledTimes(2))
    expect(updateCurrentUser).toHaveBeenLastCalledWith({
      preferences: {
        wework_new_chat_model_selection: expect.objectContaining({
          modelName: 'gpt-5.5',
          modelType: 'runtime',
        }),
      },
    })
  })

  test('restores a configured model for a cloud runtime task', async () => {
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

    await waitFor(() =>
      expect(screen.getByTestId('background-task-selected-model')).toHaveTextContent(
        'local-model:mimo'
      )
    )
    expect(screen.getByTestId('background-task-active-model')).toHaveTextContent('local-model:mimo')
    expect(screen.getByTestId('selected-model')).not.toHaveTextContent('local-model:mimo')

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('selected-model')).toHaveTextContent('local-model:mimo')
    )
    expect(screen.getByTestId('selected-mode')).toHaveTextContent('plan')
    await userEvent.click(screen.getByText('select mimo'))
    expect(updateCurrentUser).not.toHaveBeenCalled()
  })

  test('does not replace an unavailable runtime task model with the new-chat default', async () => {
    const deepseekModel: UnifiedModel = {
      name: 'deepseek-v4-flash-responses(公网)',
      type: 'public',
      provider: 'cloud',
      runtime: { family: 'openai.openai-responses' },
    }
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
                      modelSelection: {
                        modelName: 'gpt-5.6-sol',
                        modelType: 'runtime',
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
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: [deepseekModel] }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('background-runtime-task-model')).toHaveTextContent('gpt-5.6-sol')
    )
    await userEvent.click(await screen.findByText('open project runtime task'))

    await waitFor(() =>
      expect(screen.getByTestId('project-selected-model')).toHaveTextContent('none')
    )
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(screen.getByTestId('pane-session-error')).toHaveTextContent('请选择 Wework 模型')
    )
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
  })

  test('blocks interrupt-and-send when the runtime task model is unavailable', async () => {
    const deepseekModel: UnifiedModel = {
      name: 'deepseek-v4-flash-responses(公网)',
      type: 'public',
      provider: 'cloud',
      runtime: { family: 'openai.openai-responses' },
    }
    const interruptAndSendRuntimeMessage = vi.fn().mockResolvedValue({
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
                      running: true,
                      modelSelection: {
                        modelName: 'gpt-5.6-sol',
                        modelType: 'runtime',
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
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [],
      }),
      interruptAndSendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: [deepseekModel] }),
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
    await waitFor(() => expect(screen.getByTestId('follow-up-pane-busy')).toHaveTextContent('busy'))
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await waitFor(() =>
      expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    )
    await userEvent.click(screen.getByTestId('queued-interrupt-and-send-first'))

    await waitFor(() =>
      expect(screen.getByTestId('pane-session-error')).toHaveTextContent('请选择 Wework 模型')
    )
    expect(interruptAndSendRuntimeMessage).not.toHaveBeenCalled()
  })

  test('only exposes an active model while a runtime task owns the conversation', async () => {
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
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([createDevice({ device_type: 'local' })]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelSelectionProbe />, services)

    // A new chat has no conversation context, so no model owns it yet. The
    // model selector must not treat the persisted new-chat preference as an
    // active model, otherwise switching models would warn unnecessarily.
    await waitFor(() => expect(screen.getByTestId('selected-model')).toHaveTextContent('gpt-5.5'))
    expect(screen.getByTestId('active-model')).toHaveTextContent(/^$/)
    await userEvent.click(screen.getByText('select mimo'))
    await waitFor(() =>
      expect(screen.getByTestId('selected-model')).toHaveTextContent('local-model:mimo')
    )
    expect(screen.getByTestId('active-model')).toHaveTextContent(/^$/)

    await userEvent.click(screen.getByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('active-model')).toHaveTextContent('local-model:mimo')
    )
  })

  test('creates a runtime task scoped to the selected project space', async () => {
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
    await userEvent.click(screen.getByText('send with project space'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 7,
        message: '修复 CI',
        cloudProjectId: '841738010351776815',
      })
    )
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
    expect(runtimeWorkApi.getRuntimeTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        workspacePath: undefined,
        taskId: request.taskId,
        runtime: 'claude_code',
        limit: 50,
        runtimeHandle: {
          cloudProjectId: '841738010351776815',
        },
      })
    )
    expect(parseRuntimeTaskRoute(window.location.pathname, window.location.search)).toEqual({
      deviceId: 'device-1',
      taskId: request.taskId,
    })
  })

  test('creates an embedded project task in its locally selected workspace', async () => {
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
                  tasks: [],
                },
                {
                  id: 23,
                  projectId: 7,
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

    await waitFor(() => expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1'))
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('send with explicit project workspace'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 7,
        deviceWorkspaceId: 23,
        message: '修复 CI',
        clientUserMessageId: 'board-user-message-1',
      })
    )
    expect(
      getRuntimeConversationMessages({
        deviceId: 'device-1',
        taskId: request.taskId,
      }).map(message => `${message.role}:${message.content}`)
    ).toEqual(['user:修复 CI'])
  })

  test('does not dispatch an embedded Runtime task before its context is prepared', async () => {
    const preparation = deferred<void>()
    const prepareRuntimeTask = vi.fn(() => preparation.promise)
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 23,
                  projectId: 7,
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
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'codex',
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe prepareRuntimeTask={prepareRuntimeTask} />, services)

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('send with explicit project workspace'))

    await waitFor(() => expect(prepareRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).not.toHaveBeenCalled()

    preparation.resolve()
    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
  })

  test('does not dispatch an embedded Runtime task when context preparation fails', async () => {
    const prepareRuntimeTask = vi.fn(async () => {
      throw new Error('binding failed')
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 23,
                  projectId: 7,
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
      createRuntimeTask: vi.fn(),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe prepareRuntimeTask={prepareRuntimeTask} />, services)

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('send with explicit project workspace'))

    await waitFor(() => expect(prepareRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).not.toHaveBeenCalled()
  })

  test('rolls back a prepared context when the executor rejects task creation', async () => {
    const rollback = vi.fn(async () => undefined)
    const prepareRuntimeTask = vi.fn(async () => rollback)
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 23,
                  projectId: 7,
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
      createRuntimeTask: vi.fn(async request => ({
        accepted: false,
        deviceId: request.deviceId,
        taskId: request.taskId,
        error: 'executor rejected task',
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe prepareRuntimeTask={prepareRuntimeTask} />, services)

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('send with explicit project workspace'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(rollback).toHaveBeenCalledTimes(1))
  })

  test('prepares a configured model before opening a new task', async () => {
    const modelPreparation = deferred<boolean>()
    const prepareRuntimeModel = vi.fn(() => modelPreparation.promise)
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
      prepareRuntimeModel,
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

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(prepareRuntimeModel).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).not.toHaveBeenCalled()
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')

    modelPreparation.resolve(true)
    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}`
      )
    )
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

  test('does not rewrite Codex project state when opening an existing task', async () => {
    const activateRuntimeProject = vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      activateRuntimeProject,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('open project runtime task'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    expect(activateRuntimeProject).not.toHaveBeenCalled()
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

  test('does not navigate away from the board when a background task starts', async () => {
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
                  tasks: [],
                },
              ],
            },
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn(() => createResponse.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    const taskTab = {
      id: 'task-tab',
      kind: 'task' as const,
      title: '任务',
      contentRoute: '/',
      fixed: false,
    }
    const boardTab = {
      id: 'board-tab',
      kind: 'board' as const,
      title: '项目空间',
      contentRoute: '/todo',
      fixed: false,
    }
    let workspaceTabs: WorkspaceTabsContextValue = {
      tabs: [taskTab, boardTab],
      activeTabId: taskTab.id,
      activeTab: taskTab,
      openTab: vi.fn(),
      selectTab: vi.fn(),
      closeTab: vi.fn(),
      closeOtherTabs: vi.fn(),
      restoreClosedTab: vi.fn(),
      moveTab: vi.fn(),
      updateActiveTab: vi.fn(),
    }
    const view = render(
      <WorkspaceTabsContext.Provider value={workspaceTabs}>
        <WorkbenchProvider
          user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
          services={services}
          workspaceTabId={taskTab.id}
        >
          <WorkbenchProbeSessionProvider>
            <ProjectSendProbe />
          </WorkbenchProbeSessionProvider>
        </WorkbenchProvider>
      </WorkspaceTabsContext.Provider>
    )

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))
    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const optimisticRequest = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]

    workspaceTabs = {
      ...workspaceTabs,
      activeTabId: boardTab.id,
      activeTab: boardTab,
    }
    window.history.pushState({}, '', '/todo')
    window.dispatchEvent(new PopStateEvent('popstate'))
    view.rerender(
      <WorkspaceTabsContext.Provider value={workspaceTabs}>
        <WorkbenchProvider
          user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
          services={services}
          workspaceTabId={taskTab.id}
        >
          <WorkbenchProbeSessionProvider>
            <ProjectSendProbe />
          </WorkbenchProbeSessionProvider>
        </WorkbenchProvider>
      </WorkspaceTabsContext.Provider>
    )

    await act(async () => {
      createResponse.resolve({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'runtime-started',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
      })
      await createResponse.promise
    })

    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      'device-1:runtime-started'
    )
    expect(optimisticRequest.taskId).not.toBe('runtime-started')
    expect(window.location.pathname).toBe('/todo')
  })

  test('keeps a newly created task running across a stale accepted-task refresh', async () => {
    let createdTaskId = ''
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
      totalTasks: 0,
    })
    const listRuntimeWork = vi.fn().mockImplementation(() => {
      if (!createdTaskId) return Promise.resolve(initialRuntimeWork)
      return Promise.resolve(
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
                      taskId: createdTaskId,
                      workspacePath: '/workspace/project-alpha',
                      title: '修复 CI',
                      runtime: 'codex',
                      status: 'active',
                      running: false,
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
          ],
          totalTasks: 1,
        })
      )
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork,
      createRuntimeTask: vi.fn(async request => {
        createdTaskId = request.taskId
        return {
          accepted: true,
          deviceId: 'device-1',
          taskId: request.taskId,
          workspacePath: '/workspace/project-alpha',
          runtime: 'codex',
        }
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(listRuntimeWork.mock.calls.length).toBeGreaterThan(1))
    expect(screen.getByTestId('current-created-runtime-task-running')).toHaveTextContent('running')
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
    expect(screen.getByTestId('pane-session-error')).toHaveTextContent(
      'executor-not-found:device-1'
    )

    await userEvent.click(screen.getByText('start new chat'))

    expect(screen.getByTestId('pane-session-error')).toHaveTextContent('')
  })

  test('archives a failed optimistic runtime task locally and keeps it hidden after refresh', async () => {
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
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-statuses')).toHaveTextContent('failed')
    )

    await userEvent.click(screen.getByText('archive current runtime task'))

    await waitFor(() => expect(screen.getByTestId('runtime-task-titles')).toBeEmptyDOMElement())
    expect(runtimeWorkApi.archiveConversation).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('refresh work lists'))

    await waitFor(() => expect(screen.getByTestId('runtime-task-titles')).toBeEmptyDOMElement())
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
        runtimeHandle: {
          threadId: 'ready-thread',
        },
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
    expect(screen.getByTestId('current-runtime-handle-model-selection')).toHaveTextContent(
      'local-model:mimo'
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
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
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
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
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
        clientUserMessageId: expect.stringMatching(/^runtime-local-pane-/),
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
        deviceId: 'device-1',
        message: '修复 CI',
        initialGoal: {
          objective: '修复 CI',
          status: 'active',
          tokenBudget: null,
        },
      })
    )
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: request.taskId,
        subtaskId: 'goal-turn',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
      streamHandlers.onChatDone?.({
        taskId: request.taskId,
        subtaskId: 'goal-turn',
        deviceId: 'device-1',
        result: { value: 'initial turn settled before goal lookup' },
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('current-created-runtime-task-running')).toHaveTextContent(
        'running'
      )
    )
    expect(screen.getByTestId('pane-busy')).toHaveTextContent('busy')

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

  test('starts and sends a multi-root local project chat from its primary root', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: {
                id: 7,
                key: 'product',
                name: 'Product',
                source: 'local_project',
                roots: [
                  { kind: 'local', path: '/workspace/web/' },
                  { kind: 'local', path: '/workspace/web' },
                  { kind: 'local', path: '/workspace/api/' },
                ],
              },
              deviceWorkspaces: [
                {
                  id: 11,
                  deviceId: 'device-1',
                  deviceName: 'Local Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/web',
                  workspaceSource: 'local',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
                {
                  id: 12,
                  deviceId: 'device-1',
                  deviceName: 'Local Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/api',
                  workspaceSource: 'local',
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
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'multi-root-task',
        workspacePath: '/workspace/web',
        runtime: 'codex',
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('start new project chat'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        runtimeProjectKey: 'product',
        runtimeProjectName: 'Product',
        runtimeWorkspaceRoots: ['/workspace/web', '/workspace/api'],
      })
    )
    expect(screen.getByTestId('workbench-error')).toHaveTextContent('')
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

  test('uses local project AI settings for a new conversation', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: {
                id: 7,
                key: 'project-7',
                name: 'Wegent',
                source: 'local_project',
                aiSettings: {
                  instructions: 'Run focused project tests.',
                  modelSelection: {
                    modelName: 'project-model',
                    modelType: 'runtime',
                    options: { reasoning: 'medium' },
                  },
                  plugins: [
                    {
                      id: 'quality-gate@team-market',
                      pluginName: 'quality-gate',
                      marketplaceId: 'team-market',
                      displayName: 'Quality Gate',
                    },
                  ],
                },
              },
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
      modelApi: {
        listModels: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'project-model',
              type: 'runtime',
              provider: 'local',
              config: {
                weworkModelKind: 'codex-provider',
                ui: {
                  family: 'codex-provider',
                  reasoningEfforts: ['low', 'medium', 'high'],
                },
              },
            },
          ],
        }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'project-model',
        modelType: 'runtime',
        modelOptions: expect.objectContaining({ reasoning: 'medium' }),
        projectInstructions: 'Run focused project tests.',
        projectPlugins: [
          {
            id: 'quality-gate@team-market',
            pluginName: 'quality-gate',
            marketplaceId: 'team-market',
            displayName: 'Quality Gate',
          },
        ],
      })
    )
  })

  test('restores the local project default after a task-specific model override', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: {
                id: 7,
                key: 'project-7',
                name: 'Wegent',
                source: 'local_project',
                aiSettings: {
                  modelSelection: {
                    modelName: 'project-model',
                    modelType: 'runtime',
                    options: { reasoning: 'medium' },
                  },
                },
              },
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
    const models: UnifiedModel[] = [
      {
        name: 'project-model',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-provider',
          ui: {
            family: 'codex-provider',
            reasoningEfforts: ['low', 'medium', 'high'],
          },
        },
      },
      {
        name: 'override-model',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-provider',
          ui: {
            family: 'codex-provider',
            reasoningEfforts: ['low', 'medium', 'high'],
          },
        },
      },
    ]
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('select project'))
    await waitFor(() =>
      expect(screen.getByTestId('project-selected-model')).toHaveTextContent('project-model')
    )
    expect(screen.getByTestId('project-reasoning-effort')).toHaveTextContent('medium')

    await userEvent.click(screen.getByText('select override model'))
    await userEvent.click(screen.getByText('set high reasoning'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'override-model',
        modelOptions: expect.objectContaining({ reasoning: 'high' }),
      })
    )

    await userEvent.click(screen.getByText('start new project chat'))

    await waitFor(() =>
      expect(screen.getByTestId('project-selected-model')).toHaveTextContent('project-model')
    )
    expect(screen.getByTestId('project-reasoning-effort')).toHaveTextContent('medium')
  })

  test('updates the global new-task model from a follow-global local project', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: {
                id: 7,
                key: 'project-7',
                name: 'Wegent',
                source: 'local_project',
                aiSettings: {
                  modelSelection: null,
                },
              },
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
    })
    const models: UnifiedModel[] = [
      {
        name: 'global-model',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-provider',
          ui: {
            family: 'codex-provider',
            reasoningEfforts: ['low', 'medium', 'high'],
          },
        },
      },
      {
        name: 'override-model',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-provider',
          ui: {
            family: 'codex-provider',
            reasoningEfforts: ['low', 'medium', 'high'],
          },
        },
      },
    ]
    const updateCurrentUser = vi.fn().mockResolvedValue({})
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      userApi: {
        updateCurrentUser,
      } as Partial<WorkbenchServices['userApi']> as WorkbenchServices['userApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbenchForUser(
      <ProjectSendProbe />,
      {
        id: 1,
        user_name: 'alice',
        email: 'a@b.c',
        preferences: {
          wework_new_chat_model_selection: {
            modelName: 'global-model',
            modelType: 'runtime',
            options: { reasoning: 'medium' },
          },
        },
      },
      services
    )

    await userEvent.click(await screen.findByText('select project'))
    await waitFor(() =>
      expect(screen.getByTestId('project-selected-model')).toHaveTextContent('global-model')
    )

    await userEvent.click(screen.getByText('select override model'))
    await userEvent.click(screen.getByText('set high reasoning'))

    await waitFor(() =>
      expect(updateCurrentUser).toHaveBeenLastCalledWith({
        preferences: {
          wework_new_chat_model_selection: {
            modelName: 'override-model',
            modelType: 'runtime',
            options: expect.objectContaining({ reasoning: 'high' }),
          },
        },
      })
    )

    await userEvent.click(screen.getByText('start new project chat'))

    await waitFor(() =>
      expect(screen.getByTestId('project-selected-model')).toHaveTextContent('override-model')
    )
    expect(screen.getByTestId('project-reasoning-effort')).toHaveTextContent('high')
  })

  test('stores one canonical model identity for selection and execution', async () => {
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
              name: 'shared-model',
              type: 'user',
              namespace: 'default',
              resourceUserId: 1,
              provider: 'cloud',
              config: {
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
          modelName: 'shared-model',
          modelType: 'user',
          options: {
            collaborationMode: 'plan',
            reasoning: 'high',
            weworkCloudModelNamespace: 'default',
            weworkCloudModelResourceUserId: '1',
            weworkCloudModelUpstreamApiFormat: 'openai-responses',
          },
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

  test('forwards the selected Claude executable to local runtime task creation', async () => {
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
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([
          createDevice({
            device_type: 'app',
          }),
        ]),
      },
      modelApi: {
        listModels: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'local-model:claude-test',
              type: 'runtime',
              provider: 'local',
              displayName: 'Claude test model',
              modelId: 'claude-upstream-model',
              config: { weworkModelKind: 'model-interface' },
            },
          ],
        }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await waitFor(() =>
      expect(screen.getByTestId('project-model-names')).toHaveTextContent('local-model:claude-test')
    )
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send with claude runtime'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: 'claude_code',
        runtimeExecutablePath: '/tmp/claude',
        modelId: 'local-model:claude-test',
        modelType: 'runtime',
        modelOptions: expect.objectContaining({ reasoning: 'high' }),
        modelSelection: {
          modelName: 'local-model:claude-test',
          modelType: 'runtime',
          options: { collaborationMode: 'default', reasoning: 'high' },
        },
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
    const getRuntimeGoal = deferred<RuntimeGoalGetResponse>()
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
      getRuntimeGoal: vi.fn().mockReturnValue(getRuntimeGoal.promise),
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
    await waitFor(() => expect(runtimeWorkApi.getRuntimeGoal).toHaveBeenCalled())
    await act(async () => {
      getRuntimeGoal.resolve({ accepted: true, goal: null })
      await getRuntimeGoal.promise
    })

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

  test('returns to the committed project pane after creating a runtime task', async () => {
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
    const previousBlankChatKey = Number(
      screen.getByTestId('runtime-pane-standalone-chat-key').textContent
    )
    await userEvent.click(screen.getByText('start new project task'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
    )
    await waitFor(() => expect(focusRequest).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('active-pane-key')).toHaveTextContent('project:7')
    expect(screen.getByTestId('pane-message-roles')).toHaveTextContent('')
    expect(screen.getByTestId('pane-goal-draft-active')).toHaveTextContent('inactive')
    expect(screen.getByTestId('runtime-pane-standalone-chat-key')).toHaveTextContent(
      String(previousBlankChatKey + 1)
    )
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
        deviceId: 'device-1',
        message: '修复 CI',
      })
    )
    expect(services.deviceApi.getHomeDirectory).not.toHaveBeenCalled()
  })

  test('sends remote project tasks directly to the device in local-first mode', async () => {
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
                  deviceId: 'remote-device',
                  deviceName: 'Remote Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  workspaceSource: 'remote',
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
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {},
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([
          createDevice(),
          createDevice({
            id: 2,
            device_id: 'remote-device',
            name: 'Remote Device',
            device_type: 'remote',
            is_default: false,
          }),
        ]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
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
        deviceId: 'remote-device',
        message: '修复 CI',
      })
    )
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
        itemId: 'assistant-streamed-answer',
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
    clearRuntimeConversationCacheForTests()
  })

  beforeEach(() => {
    clearRuntimeConversationCacheForTests()
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
    let createdClientMessageId: string | undefined
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn(async request => {
        createdClientMessageId = request.clientUserMessageId
        return {
          accepted: true,
          deviceId: 'device-1',
          taskId: request.taskId,
          workspacePath: '/workspace/project-alpha',
          runtime: 'claude_code',
        }
      }),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTaskAddress) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath ?? '/workspace/project-alpha',
        runtime: 'claude_code',
        running: false,
        messages: [
          {
            id: `${address.taskId}:user:1`,
            role: 'user',
            content: '修复 CI',
            status: 'done',
            clientUserMessageId: createdClientMessageId,
          },
          {
            id: `${address.taskId}:assistant:1`,
            role: 'assistant',
            content: 'done answer',
            status: 'done',
            completedAt: 1_787_252_400_000,
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

  test('uploads local image attachments before creating a cloud runtime task', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'claude_code',
      })),
    })
    const uploadLocalAttachmentToCloud = vi
      .fn()
      .mockResolvedValue(createImageAttachment({ id: 46 }))
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      attachmentApi: {
        uploadAttachment: vi.fn(),
        uploadLocalAttachmentToCloud,
      },
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('add local image attachment'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    expect(uploadLocalAttachmentToCloud).toHaveBeenCalledWith(
      expect.objectContaining({
        id: -45,
        filename: 'photo.png',
        local_path: LOCAL_IMAGE_ATTACHMENT_PATH,
      })
    )
    expect(request.attachmentIds).toEqual([46])
    expect(request.attachments).toEqual([
      expect.objectContaining({
        id: 46,
        filename: 'photo.png',
        mime_type: 'image/png',
      }),
    ])
  })

  test('creates a runtime task from an explicitly opened standalone workspace', async () => {
    const updateCurrentUser = vi.fn().mockResolvedValue({})
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
      userApi: {
        updateCurrentUser,
      } as Partial<WorkbenchServices['userApi']> as WorkbenchServices['userApi'],
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
        runtimeProjectKey: '/workspace/direct-codex',
        message: '修复 CI',
      })
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('projectId')
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty(
      'deviceWorkspaceId'
    )
    expect(updateCurrentUser).not.toHaveBeenCalled()
  })

  test('registers multiple selected local folders as one Codex project', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockResolvedValueOnce(createRuntimeWork({ projects: [] }))
        .mockResolvedValue(
          createRuntimeWork({
            projects: [
              {
                project: {
                  key: 'multi-project',
                  stateDeviceId: 'device-1',
                  name: 'web',
                },
                deviceWorkspaces: ['/workspace/web', '/workspace/api'].map(
                  (workspacePath, index) => ({
                    id: 101 + index,
                    deviceId: 'device-1',
                    deviceName: 'Local Device',
                    deviceStatus: 'online',
                    workspacePath,
                    workspaceKind: 'workspace',
                    workspaceSource: 'local',
                    mapped: true,
                    available: true,
                    tasks: [],
                  })
                ),
                totalTasks: 0,
              },
            ],
          })
        ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)
    await userEvent.click(await screen.findByText('open multi-root workspace'))

    await waitFor(() => expect(runtimeWorkApi.upsertLocalRuntimeProject).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.upsertLocalRuntimeProject).toHaveBeenCalledWith({
      deviceId: 'device-1',
      projectKey: expect.any(String),
      name: 'web',
      roots: ['/workspace/web', '/workspace/api'],
      runtime: 'codex',
    })
    expect(runtimeWorkApi.openRuntimeWorkspace).not.toHaveBeenCalled()
    await waitFor(() => expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('web')

    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))
    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        runtimeProjectKey: 'multi-project',
      })
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('projectId')
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty(
      'deviceWorkspaceId'
    )
  })

  test('registers a named single-folder project through the local project flow', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockResolvedValueOnce(createRuntimeWork({ projects: [] }))
        .mockResolvedValue(
          createRuntimeWork({
            projects: [
              {
                project: {
                  key: 'multi-project',
                  stateDeviceId: 'device-1',
                  name: 'Product',
                },
                deviceWorkspaces: [
                  {
                    id: 201,
                    deviceId: 'device-1',
                    deviceName: 'Local Device',
                    deviceStatus: 'online',
                    workspacePath: '/workspace/product',
                    workspaceKind: 'workspace',
                    workspaceSource: 'local',
                    mapped: true,
                    available: true,
                    tasks: [],
                  },
                ],
                totalTasks: 0,
              },
            ],
          })
        ),
      upsertLocalRuntimeProject: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        projectKey: 'multi-project',
        name: 'Product',
        roots: ['/workspace/product'],
        runtime: 'codex',
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)
    await userEvent.click(await screen.findByText('create named local project'))

    await waitFor(() => expect(runtimeWorkApi.upsertLocalRuntimeProject).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.upsertLocalRuntimeProject).toHaveBeenCalledWith({
      deviceId: 'device-1',
      projectKey: expect.any(String),
      name: 'Product',
      roots: ['/workspace/product'],
      runtime: 'codex',
    })
    expect(runtimeWorkApi.openRuntimeWorkspace).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByTestId('current-project-name')).toHaveTextContent('Product')
    )
    expect(readLastProjectId(1)).toBe(
      runtimeProjectUiId({
        key: 'multi-project',
        stateDeviceId: 'device-1',
        name: 'Product',
      })
    )
  })

  test('delegates standalone conversation workspace creation to the runtime', async () => {
    vi.setSystemTime(new Date('2026-06-25T09:30:00.000Z'))
    const localDevice = createDevice({
      device_id: 'device-1',
      device_type: 'local',
      is_default: true,
    })
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
        listDevices: vi.fn().mockResolvedValue([localDevice]),
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
    expect(services.deviceApi.getHomeDirectory).not.toHaveBeenCalled()
    expect(services.deviceApi.createDirectory).not.toHaveBeenCalled()
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        standaloneChatWorkspace: true,
        message: '修复 CI',
      })
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('projectId')
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('teamId')
    await waitFor(() =>
      expect(runtimeWorkSyncMocks.notifyMainRuntimeWorkChanged).toHaveBeenCalledWith({
        deviceId: 'device-1',
        taskId: 'conversation-created',
      })
    )
    expect(screen.getByTestId('workbench-error')).not.toHaveTextContent(
      '请选择项目或打开设备工作区后再发送'
    )
    expect(screen.getByTestId('project-browser-annotation-command')).toHaveTextContent('none')
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
    expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent('1')
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
        runtimeProjectKey: '/workspace/cli-codex',
        message: '修复 CI',
      })
    )
  })

  test('keeps the opened cloud standalone workspace device after a work list refresh', async () => {
    const cloudDevice = createDevice({
      id: 21,
      device_id: 'device-cloud',
      name: 'Cloud Device',
      device_type: 'cloud',
    })
    const localDevice = createDevice({
      id: 22,
      device_id: 'device-local',
      name: 'This Mac',
      device_type: 'local',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork({ projects: [] })),
      openRuntimeWorkspace: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-cloud',
        workspacePath: '/workspace/cloud',
        runtime: 'codex',
      }),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([cloudDevice, localDevice]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(screen.getByText('open cloud standalone workspace'))
    await waitFor(() => expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('standalone-device-id')).toHaveTextContent('device-cloud')
    expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent('/workspace/cloud')

    await userEvent.click(screen.getByText('refresh work lists'))
    await waitFor(() => expect(runtimeWorkApi.listRuntimeWork.mock.calls.length).toBeGreaterThan(1))
    expect(screen.getByTestId('standalone-device-id')).toHaveTextContent('device-cloud')
    expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent('/workspace/cloud')
  })

  test('deduplicates a fresh local project over an aliased cloud workspace after refresh', async () => {
    const localDevice = createDevice({
      id: 31,
      device_id: 'device-local',
      name: 'This Mac',
      device_type: 'local',
    })
    const cloudDevice = createDevice({
      id: 32,
      device_id: 'device-cloud',
      name: 'Cloud Device',
      device_type: 'cloud',
    })
    const localRuntimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: 'local-project', name: 'Cloud Repo' },
          deviceWorkspaces: [
            {
              id: null,
              projectId: null,
              deviceId: 'device-local',
              deviceName: 'This Mac',
              deviceStatus: 'online',
              workspacePath: '/workspace/cloud',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: 'local-task-1',
                  workspacePath: '/workspace/cloud',
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
    const cloudRuntimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { id: 50, key: 'cloud-project', name: 'Cloud Repo' },
          deviceWorkspaces: [
            {
              id: 51,
              projectId: 50,
              deviceId: 'device-cloud',
              deviceName: 'Cloud Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/cloud',
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
    }
    const cloudListDevices = vi
      .fn()
      .mockResolvedValueOnce([cloudDevice])
      .mockResolvedValue([{ ...cloudDevice, app_device_id: 'device-local' }])
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(localRuntimeWork),
      openRuntimeWorkspace: vi.fn().mockImplementation(async ({ deviceId, workspacePath }) => ({
        accepted: true,
        deviceId,
        workspacePath,
        runtime: 'codex',
      })),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([localDevice, cloudDevice]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: cloudListDevices,
        listRuntimeWork: vi.fn().mockResolvedValue(cloudRuntimeWork),
      },
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(screen.getByText('open cloud standalone workspace'))
    await waitFor(() => expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('standalone-device-id')).toHaveTextContent('device-cloud')

    await userEvent.click(screen.getByText('open local workspace over cloud path'))
    await waitFor(() => expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledTimes(2))

    await userEvent.click(screen.getByText('refresh work lists'))
    await waitFor(() => expect(runtimeWorkApi.listRuntimeWork.mock.calls.length).toBeGreaterThan(1))
    await waitFor(() => expect(cloudListDevices.mock.calls.length).toBeGreaterThan(1))

    // The local and cloud copies of the same workspace must collapse into one project.
    expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1')
    expect(screen.getByTestId('standalone-device-id')).toHaveTextContent('device-local')
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

  test('does not restore a removed standalone workspace from an in-flight cloud refresh', async () => {
    const cloudRuntimeWork = deferred<RuntimeWorkListResponse>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork()),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([createDevice()]),
        listRuntimeWork: vi.fn(() => cloudRuntimeWork.promise),
      },
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(screen.getByText('open standalone workspace'))
    await waitFor(() =>
      expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent(
        '/workspace/direct-codex'
      )
    )
    await userEvent.click(screen.getByText('remove standalone workspace'))
    await waitFor(() =>
      expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent('none')
    )

    await act(async () => {
      cloudRuntimeWork.resolve(
        createRuntimeWork({
          chats: [
            {
              deviceId: 'device-1',
              deviceName: 'Local Device',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/workspace/direct-codex',
              workspaceKind: 'chat',
              tasks: [],
            },
          ],
        })
      )
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-chat-workspaces')).toHaveTextContent(/^$/)
    )
    expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent('none')

    await userEvent.click(screen.getByText('open standalone workspace'))

    await waitFor(() => expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent(
      '/workspace/direct-codex'
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

  test('removes a multi-root local runtime project through its primary root', async () => {
    const multiRootRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: {
            id: 7,
            key: 'product',
            name: 'Product',
            source: 'local_project',
            roots: [
              { kind: 'local', path: '/workspace/web' },
              { kind: 'local', path: '/workspace/api' },
            ],
          },
          deviceWorkspaces: [
            {
              id: 11,
              deviceId: 'device-1',
              workspacePath: '/workspace/web',
              available: true,
              tasks: [],
            },
            {
              id: 12,
              deviceId: 'device-1',
              workspacePath: '/workspace/api',
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
      listRuntimeWork: vi
        .fn()
        .mockResolvedValueOnce(multiRootRuntimeWork)
        .mockResolvedValue(createRuntimeWork({ projects: [], totalTasks: 0 })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent('Product')
    )
    await userEvent.click(screen.getByText('remove runtime project'))

    await waitFor(() => expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      projectKey: 'product',
      workspacePath: '/workspace/web',
      runtime: 'codex',
    })
    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(/^$/)
    )
  })

  test('does not restore a removed workspace under different project and device identities', async () => {
    const cloudRuntimeWork = deferred<RuntimeWorkListResponse>()
    const staleRuntimeWork = createRuntimeWork()
    writeCachedRemoteRuntimeWork(1, staleRuntimeWork)
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockResolvedValueOnce(staleRuntimeWork)
        .mockResolvedValue(createRuntimeWork({ projects: [], totalTasks: 0 })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([
          {
            id: 1,
            device_id: 'device-1',
            name: 'Project Device',
            status: 'online',
            is_default: false,
            device_type: 'remote',
            bind_shell: 'claudecode',
          },
        ]),
        listRuntimeWork: vi.fn(() => cloudRuntimeWork.promise),
      },
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent('Wegent')
    )
    await userEvent.click(screen.getByText('remove runtime project'))
    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(/^$/)
    )
    expect(
      JSON.parse(localStorage.getItem('wework.workbench.remoteRuntimeWork.v2.1') ?? '{}')
        .runtimeWork.projects
    ).toEqual([])

    await act(async () => {
      cloudRuntimeWork.resolve(
        createRuntimeWork({
          projects: [
            {
              project: { id: 8, key: 'cloud-project', name: 'Restored Wegent' },
              deviceWorkspaces: [
                {
                  id: 23,
                  projectId: 8,
                  deviceId: 'cloud-device',
                  deviceName: 'Cloud Device',
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
      )
    })

    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(/^$/)
    )
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

  test('removes an offline cloud project locally without calling the target device', async () => {
    const offlineCloudRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, key: '/cloud/project-alpha', name: 'Offline Cloud Project' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'cloud-device',
              remoteHostId: 'cloud-device',
              deviceName: 'Cloud Device',
              deviceStatus: 'offline',
              workspacePath: '/cloud/project-alpha',
              workspaceSource: 'remote',
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
    const emptyRuntimeWork = createRuntimeWork({ projects: [], totalTasks: 0 })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(emptyRuntimeWork),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi
          .fn()
          .mockResolvedValue([createDevice({ device_id: 'local-device', device_type: 'local' })]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([
          createDevice({
            device_id: 'cloud-device',
            device_type: 'cloud',
            is_default: false,
            status: 'offline',
          }),
        ]),
        listRuntimeWork: vi.fn().mockResolvedValue(offlineCloudRuntimeWork),
      },
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(
        'Offline Cloud Project'
      )
    )
    await userEvent.click(screen.getByText('remove runtime project'))

    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(/^$/)
    )
    expect(runtimeWorkApi.removeRuntimeWorkspace).not.toHaveBeenCalled()
    expect(runtimeWorkApi.listRuntimeWork.mock.calls.length).toBeGreaterThan(1)
    expect(
      JSON.parse(localStorage.getItem('wework.workbench.remoteRuntimeWork.v2.1') ?? '{}')
        .runtimeWork.projects
    ).toEqual([])
  })

  test('removes an offline remote project only from the local Codex index', async () => {
    const offlineRemoteRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: {
            id: 7,
            key: '/srv/project-alpha',
            sidebarStateKey: 'remote-project-id',
            name: 'Offline Remote Project',
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
              deviceStatus: 'offline',
              workspacePath: '/srv/project-alpha',
              workspaceSource: 'remote',
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
    const emptyRuntimeWork = createRuntimeWork({ projects: [], totalTasks: 0 })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockResolvedValueOnce(offlineRemoteRuntimeWork)
        .mockResolvedValue(emptyRuntimeWork),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([
          createDevice({ device_id: 'local-device', device_type: 'local' }),
          createDevice({
            device_id: 'remote-device',
            device_type: 'remote',
            is_default: false,
            status: 'offline',
          }),
        ]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([
          createDevice({
            device_id: 'remote-device',
            device_type: 'remote',
            is_default: false,
            status: 'offline',
          }),
        ]),
        listRuntimeWork: vi.fn().mockResolvedValue(emptyRuntimeWork),
      },
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={services}
        syncRemoteProjects={false}
      >
        <RuntimeProjectMutationProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(
        'Offline Remote Project'
      )
    )
    await userEvent.click(screen.getByText('remove runtime project'))

    await waitFor(() => expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'local-device',
      projectKey: 'remote-project-id',
      workspacePath: '/srv/project-alpha',
      runtime: 'codex',
    })
    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(/^$/)
    )
    expect(runtimeWorkApi.listRuntimeWork.mock.calls.length).toBeGreaterThan(1)
  })

  test('keeps an offline remote project visible when the local index removal fails', async () => {
    const offlineRemoteRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: {
            id: 7,
            key: '/srv/project-alpha',
            sidebarStateKey: 'remote-project-id',
            name: 'Offline Remote Project',
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
              deviceStatus: 'offline',
              workspacePath: '/srv/project-alpha',
              workspaceSource: 'remote',
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
      listRuntimeWork: vi.fn().mockResolvedValue(offlineRemoteRuntimeWork),
      removeRuntimeWorkspace: vi.fn().mockResolvedValue({
        accepted: false,
        deviceId: 'local-device',
        workspacePath: '/srv/project-alpha',
        runtime: 'codex',
        error: 'Failed to write local Codex state',
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([]),
        listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork({ projects: [] })),
      },
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={services}
        syncRemoteProjects={false}
      >
        <RuntimeProjectMutationProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(
        'Offline Remote Project'
      )
    )
    await userEvent.click(screen.getByText('remove runtime project'))

    await waitFor(() =>
      expect(screen.getByTestId('mutation-error')).toHaveTextContent(
        'Failed to write local Codex state'
      )
    )
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledTimes(1)
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'local-device',
      projectKey: 'remote-project-id',
      workspacePath: '/srv/project-alpha',
      runtime: 'codex',
    })
    expect(screen.getByTestId('mutation-project-order')).toHaveTextContent('Offline Remote Project')
  })

  test('renames and removes remote projects from both the remote executor and local Codex index', async () => {
    const initialRemoteProjectSync = deferred<{ accepted: boolean; deviceId: string }>()
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
      syncRuntimeRemoteProjects: vi
        .fn()
        .mockImplementationOnce(() => initialRemoteProjectSync.promise)
        .mockResolvedValue({ accepted: true, deviceId: 'local-device' }),
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
        listRuntimeWork: vi.fn().mockResolvedValue(remoteRuntimeWork),
      },
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await waitFor(() => expect(runtimeWorkApi.syncRuntimeRemoteProjects).toHaveBeenCalledTimes(1))
    await userEvent.click(await screen.findByText('rename runtime project'))
    await waitFor(() => expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenNthCalledWith(1, {
      deviceId: 'remote-device',
      projectKey: '/srv/project-alpha',
      workspacePath: '/srv/project-alpha',
      runtime: 'codex',
      name: 'Hello project',
    })
    await act(async () => {
      initialRemoteProjectSync.resolve({ accepted: true, deviceId: 'local-device' })
    })
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
    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(/^$/)
    )
    await userEvent.click(screen.getByText('refresh runtime projects'))
    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent('Wegent')
    )
    expect(runtimeWorkApi.syncRuntimeRemoteProjects).toHaveBeenCalledTimes(1)
  })

  test('does not treat a local-only empty remote view as an authoritative deletion', async () => {
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
              workspacePath: '/srv/project-alpha',
              workspaceSource: 'remote',
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
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await waitFor(() => expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(/^$/)
    )
    expect(runtimeWorkApi.syncRuntimeRemoteProjects).not.toHaveBeenCalled()
  })

  test('does not sync remote projects from an inactive workspace tab', async () => {
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
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={services}
        syncRemoteProjects={false}
      >
        <RuntimeProjectMutationProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalled())
    expect(runtimeWorkApi.syncRuntimeRemoteProjects).not.toHaveBeenCalled()
  })

  test('archives a worktree task without prompting and preserves a snapshot', async () => {
    const updateTaskTrackingStatus = vi.fn().mockResolvedValue(null)
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
                  workspacePath: '/workspace/project-alpha',
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
      projectSpaceApis: {
        local: { updateTaskTrackingStatus },
      } as unknown as WorkbenchServices['projectSpaceApis'],
    })
    const archivedAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-worktree',
      workspacePath: '/workspace/worktrees/9/project-alpha',
    }
    applyRuntimeConversationAction(archivedAddress, {
      type: 'user_added',
      message: {
        id: 'cached-assistant',
        role: 'user',
        content: 'cached archived transcript',
        status: 'done',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    })

    renderWorkbench(<ArchiveRuntimeTaskProbe />, services)

    await waitFor(() => expect(screen.getByText('archive worktree task')).toBeInTheDocument())
    await userEvent.click(screen.getByText('archive worktree task'))

    await waitFor(() => expect(screen.getByTestId('archive-result')).toHaveTextContent('archived'))
    expect(screen.getByTestId('workbench-error')).toHaveTextContent('')
    expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1)
    expect(updateTaskTrackingStatus).not.toHaveBeenCalled()
    expect(getRuntimeConversationMessages(archivedAddress)).toEqual([])
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

    await act(async () => {
      archiveRequest.resolve({
        accepted: true,
        taskId: 'runtime-worktree',
        workspacePath: '/workspace/worktrees/9/project-alpha',
        runtime: 'codex',
      })
      await archiveRequest.promise
    })

    expect(screen.getByTestId('current-runtime-task')).toHaveTextContent('runtime-b')
  })

  test('preserves a newer non-task route when the current task finishes archiving', async () => {
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

    await waitFor(() => expect(screen.getByText('open archive target')).toBeInTheDocument())
    await userEvent.click(screen.getByText('open archive target'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task')).toHaveTextContent('runtime-worktree')
    )
    await userEvent.click(screen.getByText('archive worktree task'))
    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1))

    window.history.pushState({}, '', '/settings/archived-conversations')
    window.dispatchEvent(new PopStateEvent('popstate'))

    await act(async () => {
      archiveRequest.resolve({
        accepted: true,
        taskId: 'runtime-worktree',
        workspacePath: '/workspace/worktrees/9/project-alpha',
        runtime: 'codex',
      })
      await archiveRequest.promise
    })

    await waitFor(() => expect(screen.getByTestId('current-runtime-task')).toHaveTextContent(''))
    expect(window.location.pathname).toBe('/settings/archived-conversations')
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

  test('archives a remote task locally without triggering a cloud sync', async () => {
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
    expect(screen.getByTestId('archive-remote-task-titles')).toHaveTextContent('')
    expect(cloudListRuntimeWork).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByText('refresh work lists'))
    await waitFor(() => expect(cloudListRuntimeWork).toHaveBeenCalledTimes(2))
    postArchiveCloudWork.resolve({ projects: [], chats: [], totalTasks: 0 })
    await waitFor(() =>
      expect(screen.getByTestId('archive-remote-task-titles')).toHaveTextContent('')
    )
  })

  test('keeps an archived remote task hidden when the local list refresh fails', async () => {
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
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockRejectedValue(new Error('local list unavailable')),
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
        listRuntimeWork: vi.fn().mockResolvedValue(remoteRuntimeWork),
      },
    })

    renderWorkbench(<ArchiveRemoteRuntimeTaskProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('archive-remote-task-titles')).toHaveTextContent('Remote task')
    )
    runtimeWorkApi.listRuntimeWork.mockClear()
    await userEvent.click(screen.getByText('archive remote task'))

    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(1)
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
        itemId: 'assistant-streamed-answer',
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

  test('continues a failed conversation in a new turn when the failed subtask is reused', async () => {
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
    expect(screen.getByTestId('assistant-error-card')).toBeInTheDocument()
    expect(screen.getAllByTestId('message-user').at(-1)).toHaveTextContent('继续')
    expect(sendRuntimeMessage.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        address: expect.objectContaining({ taskId: 'runtime-restored' }),
        message: RUNTIME_RETRY_CONTINUATION_PROMPT,
        clientUserMessageId: expect.stringMatching(/^runtime-retry-continuation-/),
      })
    )
    expect(sendRuntimeMessage.mock.calls[1][0]).not.toHaveProperty('retrySourceTurnId')
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
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
      'thinking:读取历史记录:done|text:处理完成:done'
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
      if (request.beforeCursor === 'opaque-older-page') {
        return Promise.resolve({
          taskId: 'runtime-a',
          workspacePath: '/workspace/project-alpha',
          runtime: 'codex',
          messages: [
            {
              id: 'runtime-a:user:o20',
              role: 'user',
              content: 'older message',
              messageIndex: 20,
            },
          ],
          hasMoreBefore: false,
          beforeCursor: null,
        } satisfies RuntimeTranscriptResponse)
      }
      return Promise.resolve({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [
          {
            id: 'runtime-a:user:o120',
            role: 'user',
            content: 'recent message',
            messageIndex: 120,
          },
        ],
        hasMoreBefore: true,
        beforeCursor: 'opaque-older-page',
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
      beforeCursor: 'opaque-older-page',
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

  test('restores cached history when returning before another transcript finishes loading', async () => {
    const runtimeBTranscript = deferred<RuntimeTranscriptResponse>()
    const getRuntimeTranscript = vi.fn((address: RuntimeTaskAddress) => {
      if (address.taskId === 'runtime-b') return runtimeBTranscript.promise
      return Promise.resolve({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'message a' }],
      } satisfies RuntimeTranscriptResponse)
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message a')
    )

    await userEvent.click(screen.getByText('open runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-b'
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('runtime-transcript-loading')).toHaveTextContent('loading')
    )
    expect(screen.getByTestId('runtime-open-messages')).toBeEmptyDOMElement()

    await userEvent.click(screen.getByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message a')
    )
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(3)

    await act(async () => {
      runtimeBTranscript.resolve({
        taskId: 'runtime-b',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-b:user:1', role: 'user', content: 'message b' }],
      })
      await runtimeBTranscript.promise
    })

    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      'device-1:runtime-a'
    )
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message a')
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('message b')
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

  test('does not create a pane-scoped stream subscription when the same task is rebuilt', async () => {
    const globalCleanup = vi.fn()
    const subscribe = vi.fn((handlers: ChatStreamHandlers) =>
      handlers.scope ? vi.fn() : globalCleanup
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
    const paneSubscribeCount = () =>
      subscribe.mock.calls.filter(([handlers]) => handlers.scope?.taskId === 'runtime-a').length
    const globalSubscribeCount = () =>
      subscribe.mock.calls.filter(([handlers]) => hasRuntimeStreamHandler(handlers)).length
    await waitFor(() => expect(globalSubscribeCount()).toBe(1))
    expect(paneSubscribeCount()).toBe(0)

    await userEvent.click(screen.getByText('rebuild same runtime address'))

    expect(globalSubscribeCount()).toBe(1)
    expect(paneSubscribeCount()).toBe(0)
  })

  test('reloads an empty runtime transcript after the task address is hydrated', async () => {
    const getRuntimeTranscript = vi.fn((address: RuntimeTaskAddress) => {
      if (!address.workspacePath) {
        return Promise.resolve({
          taskId: 'runtime-a',
          messages: [],
        } satisfies RuntimeTranscriptResponse)
      }
      return Promise.resolve({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'restored user message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'restored assistant message',
          },
        ],
      } satisfies RuntimeTranscriptResponse)
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimePaneAddressHydrationProbe />, services)

    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('hydrated-runtime-messages')).toBeEmptyDOMElement()
    expect(screen.getByTestId('hydrated-runtime-transcript-error')).toHaveTextContent('none')

    await userEvent.click(screen.getByText('hydrate runtime address'))

    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(2))
    expect(getRuntimeTranscript).toHaveBeenLastCalledWith({
      deviceId: 'device-1',
      taskId: 'runtime-a',
      runtime: 'codex',
      threadId: 'thread-a',
      workspacePath: '/workspace/project-alpha',
      limit: 50,
    })
    await waitFor(() =>
      expect(screen.getByTestId('hydrated-runtime-messages')).toHaveTextContent(
        'restored user message|restored assistant message'
      )
    )
    expect(screen.getByTestId('hydrated-runtime-transcript-error')).toHaveTextContent('none')
  })

  test('clears the task plan progress when starting a new chat', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const services = createWorkbenchServices({
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })
    renderWorkbench(<RuntimePlanScopeProbe />, services)

    await userEvent.click(await screen.findByText('open runtime plan scope'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-plan-scope-task')).toHaveTextContent('runtime-plan-scope')
    )

    await act(async () => {
      streamHandlers.onRuntimePlanUpdated?.({
        taskId: 'runtime-plan-scope',
        deviceId: 'device-1',
        plan: [{ step: 'Implement the fix', status: 'inProgress' }],
      })
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
      clientUserMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
    })
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('继续修')
  })

  test('shows user messages sent from an external runtime action', async () => {
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
        <ExternalRuntimeSendProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('repair pull request'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientUserMessageId: expect.stringMatching(/^runtime-local-pane-/),
      message: '修复 PR #2631',
    })
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('修复 PR #2631')
  })

  test('removes an external optimistic user message when sending fails', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage: vi.fn().mockResolvedValue({
        accepted: false,
        taskId: 'runtime-a',
        error: 'send failed',
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <ExternalRuntimeSendProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('repair pull request'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('修复 PR #2631')
    )
  })

  test('only emits browser cleanup commands when browser annotations are cleared', async () => {
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

    await userEvent.click(screen.getByTestId('follow-up-add-code-comment'))
    await userEvent.click(screen.getByText('clear code comments'))
    expect(screen.getByTestId('code-comment-context-count')).toHaveTextContent('0')
    expect(screen.getByTestId('browser-annotation-command')).toHaveTextContent('none')

    await userEvent.click(screen.getByTestId('follow-up-add-browser-annotation'))
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('code-comment-context-count')).toHaveTextContent('0')
    expect(screen.getByTestId('browser-annotation-command')).toHaveTextContent('1:send_success')
  })

  test('shows the runtime rejection in the active pane when a follow-up send fails', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: false,
      taskId: 'runtime-a',
      error: 'runtime send failed',
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

    await waitFor(() =>
      expect(screen.getByTestId('pane-session-error')).toHaveTextContent('runtime send failed')
    )
    expect(screen.getByTestId('composer-input')).toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-error')).toHaveTextContent('')
  })

  test('delegates model preparation to the runtime send operation', async () => {
    const prepareRuntimeModel = vi.fn()
    const sendRuntimeMessage = vi.fn().mockRejectedValue(new Error('已取消模型配置同步'))
    const runtimeWorkApi = createRuntimeWorkApiMock({
      prepareRuntimeModel,
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

    await waitFor(() =>
      expect(screen.getByTestId('pane-session-error')).toHaveTextContent('已取消模型配置同步')
    )
    expect(prepareRuntimeModel).not.toHaveBeenCalled()
    expect(sendRuntimeMessage).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('composer-input')).toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-error')).toHaveTextContent('')
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
    expect(screen.getByTestId('follow-up-messages')).toBeEmptyDOMElement()
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
        itemId: 'assistant-retained-1',
        offset: 0,
        content: 'retained stream output',
        deviceId: 'device-1',
      })
    })

    expect(screen.getByTestId('follow-up-current-runtime-task')).toHaveTextContent('none')
    expect(screen.getByTestId('follow-up-pane-busy')).toHaveTextContent('idle')
    expect(screen.getByTestId('follow-up-messages')).toBeEmptyDOMElement()

    await userEvent.click(screen.getByText('open follow-up runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-current-runtime-task')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('follow-up-messages')).toHaveTextContent('retained stream output')
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

  test('keeps blank chat draft when starting a project chat from a runtime task', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'message runtime-a' }],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('修复 CI')
    const blankChatKey = screen.getByTestId('standalone-chat-key').textContent

    await userEvent.click(screen.getByText('open project runtime task'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    await userEvent.click(screen.getByText('start new project chat'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
    )
    expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent(blankChatKey ?? '')
    expect(screen.getByTestId('composer-input')).toHaveTextContent('修复 CI')
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
        app: {
          id: 'plugin:documents',
          name: 'Documents',
          pluginKey: 'documents',
        },
        templates: [
          {
            name: 'Draft a document',
            path: 'draft-document',
            description: 'Draft a document from the current context',
          },
        ],
      })
    )

    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() => expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent('1'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('Documents')
    expect(screen.getByTestId('trial-plugin-app')).toHaveTextContent('documents')
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test('lets only the active workspace tab consume a queued plugin trial', async () => {
    const user = { id: 1, user_name: 'alice', email: 'a@b.c' }
    render(
      <>
        <WorkbenchProvider
          user={user}
          services={createWorkbenchServices()}
          consumePluginTrials={false}
        >
          <WorkbenchProbeSessionProvider>
            <PluginTrialInputProbe testId="inactive-plugin-trial-input" />
          </WorkbenchProbeSessionProvider>
        </WorkbenchProvider>
        <WorkbenchProvider user={user} services={createWorkbenchServices()} consumePluginTrials>
          <WorkbenchProbeSessionProvider>
            <PluginTrialInputProbe testId="active-plugin-trial-input" />
          </WorkbenchProbeSessionProvider>
        </WorkbenchProvider>
      </>
    )

    sessionStorage.setItem(
      'wework:pending-plugin-trial',
      JSON.stringify({
        input: '[$Documents](plugin://documents@wegent) ',
        pluginName: 'Documents',
        openInNewChat: true,
      })
    )
    act(() => window.dispatchEvent(new Event(PLUGIN_TRIAL_QUEUED_EVENT)))

    await waitFor(() =>
      expect(screen.getByTestId('active-plugin-trial-input')).toHaveTextContent('Documents')
    )
    expect(screen.getByTestId('inactive-plugin-trial-input')).toBeEmptyDOMElement()
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test('lets only the active workspace tab publish workbench diagnostics', async () => {
    const user = { id: 1, user_name: 'alice', email: 'a@b.c' }
    const services = createWorkbenchServices()
    render(
      <>
        <WorkbenchProvider
          user={user}
          services={services}
          consumePluginTrials={false}
          publishDebugSnapshots={false}
          syncRemoteProjects={false}
          syncRuntimeTaskLifecycle={false}
        >
          <WorkbenchProbeSessionProvider>
            <DebugSnapshotInputProbe testId="set-inactive-draft" value="inactive draft" />
          </WorkbenchProbeSessionProvider>
        </WorkbenchProvider>
        <WorkbenchProvider
          user={user}
          services={services}
          consumePluginTrials
          publishDebugSnapshots
          syncRemoteProjects={false}
          syncRuntimeTaskLifecycle={false}
        >
          <WorkbenchProbeSessionProvider>
            <DebugSnapshotInputProbe testId="set-active-draft" value="active draft" />
          </WorkbenchProbeSessionProvider>
        </WorkbenchProvider>
      </>
    )

    await userEvent.click(screen.getByTestId('set-active-draft'))
    await waitFor(() =>
      expect(getWorkbenchDebugSnapshot().workbench?.composer?.currentInputLength).toBe(
        'active draft'.length
      )
    )

    await userEvent.click(screen.getByTestId('set-inactive-draft'))
    await new Promise(resolve => window.setTimeout(resolve, 200))

    expect(getWorkbenchDebugSnapshot().workbench?.composer?.currentInputLength).toBe(
      'active draft'.length
    )
  })

  test('preserves a queued plugin trial until the workspace tab becomes active', async () => {
    const user = { id: 1, user_name: 'alice', email: 'a@b.c' }
    const services = createWorkbenchServices()
    const renderProvider = (consumePluginTrials: boolean) => (
      <WorkbenchProvider user={user} services={services} consumePluginTrials={consumePluginTrials}>
        <WorkbenchProbeSessionProvider>
          <PluginTrialInputProbe testId="deferred-plugin-trial-input" />
        </WorkbenchProbeSessionProvider>
      </WorkbenchProvider>
    )
    const view = render(renderProvider(false))

    sessionStorage.setItem(
      'wework:pending-plugin-trial',
      JSON.stringify({
        input: '[$Documents](plugin://documents@wegent) ',
        pluginName: 'Documents',
        openInNewChat: true,
      })
    )
    act(() => window.dispatchEvent(new Event(PLUGIN_TRIAL_QUEUED_EVENT)))

    expect(screen.getByTestId('deferred-plugin-trial-input')).toBeEmptyDOMElement()
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).not.toBeNull()

    view.rerender(renderProvider(true))

    await waitFor(() =>
      expect(screen.getByTestId('deferred-plugin-trial-input')).toHaveTextContent('Documents')
    )
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test('hydrates queued plugin trial input into the current runtime task', async () => {
    renderWorkbench(<ProjectSendProbe />)

    await userEvent.click(await screen.findByText('open project runtime task'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    const standaloneChatKey = screen.getByTestId('standalone-chat-key').textContent

    sessionStorage.setItem(
      'wework:pending-plugin-trial',
      JSON.stringify({
        input: '[$Documents](plugin://documents@OpenAI Bundled) ',
        pluginName: 'Documents',
      })
    )
    window.dispatchEvent(new Event('wework:plugin-trial-queued'))

    await waitFor(() => expect(screen.getByTestId('composer-input')).toHaveTextContent('Documents'))
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      'device-1:runtime-a'
    )
    expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent(standaloneChatKey ?? '')
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test('opens a queued plugin trial in a new chat under the current project', async () => {
    renderWorkbench(<ProjectSendProbe />)

    await userEvent.click(await screen.findByText('open project runtime task'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    const standaloneChatKey = Number(screen.getByTestId('standalone-chat-key').textContent)

    sessionStorage.setItem(
      'wework:pending-plugin-trial',
      JSON.stringify({
        input: '[$Documents](plugin://documents@OpenAI Bundled) ',
        pluginName: 'Documents',
        openInNewChat: true,
      })
    )
    window.dispatchEvent(new Event('wework:plugin-trial-queued'))

    await waitFor(() => expect(screen.getByTestId('composer-input')).toHaveTextContent('Documents'))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
    expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent(
      String(standaloneChatKey + 1)
    )
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test('opens a queued plugin trial under its explicit target project', async () => {
    renderWorkbench(<ProjectSendProbe />)
    await screen.findByText('open project runtime task')
    const standaloneChatKey = Number(screen.getByTestId('standalone-chat-key').textContent)

    sessionStorage.setItem(
      'wework:pending-plugin-trial',
      JSON.stringify({
        input: '[$智能工作台开发助手](plugin://smart-app-builder@wework-personal) ',
        pluginName: '智能工作台开发助手',
        openInNewChat: true,
        targetProject: {
          id: 7,
          name: 'Wegent',
          tasks: [],
          config: {
            mode: 'workspace',
            execution: { targetType: 'local' },
            workspace: {
              source: 'local_path',
              localPath: '/tmp/blank-workbench',
            },
          },
        },
      })
    )
    act(() => window.dispatchEvent(new Event('wework:plugin-trial-queued')))

    await waitFor(() =>
      expect(screen.getByTestId('composer-input')).toHaveTextContent('智能工作台开发助手')
    )
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
    expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent(
      String(standaloneChatKey + 1)
    )
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test('opens a queued plugin trial in its explicit local workspace', async () => {
    renderWorkbench(<ProjectSendProbe />)
    await screen.findByText('open project runtime task')
    const standaloneChatKey = Number(screen.getByTestId('standalone-chat-key').textContent)

    sessionStorage.setItem(
      'wework:pending-plugin-trial',
      JSON.stringify({
        input: '[$智能工作台开发助手](plugin://smart-app-builder@wework-personal) ',
        pluginName: '智能工作台开发助手',
        openInNewChat: true,
        targetWorkspace: {
          deviceId: 'device-1',
          path: '/tmp/blank-workbench',
        },
      })
    )
    act(() => window.dispatchEvent(new Event('wework:plugin-trial-queued')))

    await waitFor(() =>
      expect(screen.getByTestId('composer-input')).toHaveTextContent('智能工作台开发助手')
    )
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('none')
    expect(screen.getByTestId('standalone-device-id')).toHaveTextContent('device-1')
    expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent(
      '/tmp/blank-workbench'
    )
    expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent(
      String(standaloneChatKey + 1)
    )
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

    expect(setRuntimeGoal).not.toHaveBeenCalled()
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientUserMessageId: expect.any(String),
      initialGoal: {
        objective: '继续修',
        status: 'active',
        tokenBudget: null,
      },
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

    renderWorkbenchWithLifecycleCoordinator(
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

  test('restores queued follow-ups after switching away from a streaming task', async () => {
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
      getRuntimeTranscript: vi.fn().mockImplementation((address: RuntimeTaskAddress) =>
        Promise.resolve({
          taskId: address.taskId,
          workspacePath: '/workspace/project-alpha',
          runtime: 'claude_code',
          messages: [
            {
              id: `${address.taskId}:user:1`,
              role: 'user',
              content: `message ${address.taskId}`,
            },
          ],
        })
      ),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbenchWithLifecycleCoordinator(<FollowUpProbe />, services)

    await userEvent.click(await screen.findByText('open follow-up runtime a'))
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())
    act(() => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    expect(sendRuntimeMessage).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('open follow-up runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-current-runtime-task')).toHaveTextContent(
        'device-1:runtime-b'
      )
    )
    expect(screen.getByTestId('queued-messages')).toBeEmptyDOMElement()
    await act(async () => {
      await Promise.resolve()
    })
    expect(sendRuntimeMessage).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('open follow-up runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-current-runtime-task')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
  })

  test('marks the current runtime task running without refreshing runtime work', async () => {
    let streamHandlers: Parameters<WorkbenchServices['chatStream']['subscribe']>[0] | null = null
    const subscribe = vi.fn(handlers => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
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

    renderWorkbenchWithLifecycleCoordinator(<RuntimeOpenProbe />, services)

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

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('running')
    )
    expect(listRuntimeWork).toHaveBeenCalledTimes(callsBeforeStart)
  })

  test('applies supervisor stream updates without an out-of-order runtime work refresh', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
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

    renderWorkbench(
      <>
        <RuntimeTopLevelStreamLifecycleProbe />
        <RuntimePaneSendProbe />
      </>,
      services
    )

    await waitFor(() => expect(streamHandlers.onRuntimeSupervisorUpdated).toBeDefined())
    const callsBeforeUpdate = listRuntimeWork.mock.calls.length

    act(() => {
      streamHandlers.onRuntimeSupervisorUpdated?.({
        taskId: 'runtime-a',
        subtaskId: 'supervisor-state-1',
        deviceId: 'device-1',
        supervisor: {
          mode: 'auto',
          status: 'active',
          instructions: 'Keep the task focused',
          modelSelection: {
            modelName: 'supervisor-model',
            modelType: 'public',
          },
          intervalSeconds: 30,
          lastEvaluatedAt: 1786557741000,
          lastContentHash: 'latest',
          lastError: null,
          suggestions: [],
        },
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-a-supervisor-last-evaluated')).toHaveTextContent(
        '1786557741000'
      )
    )
    expect(listRuntimeWork).toHaveBeenCalledTimes(callsBeforeUpdate)
  })

  test('hides the runtime goal when the settled task reports the goal complete', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const getRuntimeGoal = vi.fn().mockResolvedValue({
      accepted: true,
      goal: createRuntimeGoal({ objective: '实现目标', status: 'active' }),
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
      streamHandlers.onRuntimeGoalUpdated?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        goal: createRuntimeGoal({ objective: '实现目标', status: 'complete' }),
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-goal-objective')).toHaveTextContent('none')
    )
  })

  test('reconciles a completed Claude goal from the executor snapshot after the turn settles', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const getRuntimeGoal = vi
      .fn()
      .mockResolvedValueOnce({
        accepted: true,
        goal: createRuntimeGoal({ objective: '完成 Claude 目标', status: 'active' }),
      })
      .mockResolvedValue({
        accepted: true,
        goal: createRuntimeGoal({ objective: '完成 Claude 目标', status: 'complete' }),
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
      getRuntimeGoal,
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
      expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('active')
    )

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: 'done',
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-goal-objective')).toHaveTextContent('none')
    )
    expect(getRuntimeGoal).toHaveBeenCalledTimes(2)
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

  test('applies a delayed runtime goal after transcript hydration updates the conversation cache', async () => {
    const runtimeGoal = deferred<{
      accepted: boolean
      goal: RuntimeGoal
    }>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        running: false,
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: '继续实现目标' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: '等待恢复',
            status: 'done',
            subtaskId: '101',
          },
        ],
      }),
      getRuntimeGoal: vi.fn().mockReturnValue(runtimeGoal.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('等待恢复')
    )

    await act(async () => {
      runtimeGoal.resolve({
        accepted: true,
        goal: createRuntimeGoal({ objective: '恢复中的目标', status: 'active' }),
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-goal-objective')).toHaveTextContent('恢复中的目标')
    )
    expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('active')
  })

  test('reloads the runtime goal after the persisted task address is hydrated', async () => {
    const getRuntimeGoal = vi.fn().mockImplementation(({ address }) =>
      Promise.resolve(
        address.workspacePath
          ? {
              accepted: true,
              goal: createRuntimeGoal({
                objective: '重载后恢复的目标',
                status: 'active',
              }),
            }
          : {
              accepted: false,
              goal: null,
              error: 'runtime task was not found',
            }
      )
    )
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeGoal })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimePaneAddressHydrationProbe />, services)

    await waitFor(() => expect(getRuntimeGoal).toHaveBeenCalledTimes(1))
    expect(getRuntimeGoal).toHaveBeenLastCalledWith({
      address: {
        deviceId: 'device-1',
        taskId: 'runtime-a',
      },
    })
    expect(screen.getByTestId('hydrated-runtime-goal')).toHaveTextContent('none')

    await userEvent.click(screen.getByText('hydrate runtime address'))

    await waitFor(() => expect(getRuntimeGoal).toHaveBeenCalledTimes(2))
    expect(getRuntimeGoal).toHaveBeenLastCalledWith({
      address: {
        deviceId: 'device-1',
        taskId: 'runtime-a',
        runtime: 'codex',
        threadId: 'thread-a',
        workspacePath: '/workspace/project-alpha',
      },
    })
    expect(screen.getByTestId('hydrated-runtime-goal')).toHaveTextContent('重载后恢复的目标')
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

  test('does not poll transcript history while the live stream owns a running task', async () => {
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
    await new Promise(resolve => window.setTimeout(resolve, 2_100))
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)
    expect(getRuntimeTranscript).toHaveBeenCalledWith({
      deviceId: 'device-1',
      taskId: 'runtime-a',
      workspacePath: '/workspace/project-alpha',
      limit: 50,
    })
    expect(screen.queryByText('后台任务已完成')).not.toBeInTheDocument()
    expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('running')
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
            status: 'done',
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

    expect(setRuntimeGoal).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(runtimeWorkApi.sendRuntimeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          initialGoal: {
            objective: '更新后的目标',
            status: 'active',
            tokenBudget: null,
          },
          message: '更新后的目标',
        })
      )
    )
    expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('active')
  })

  test('resumes a paused Claude goal by starting another native Goal turn', async () => {
    const setRuntimeGoal = vi.fn().mockResolvedValue({
      accepted: true,
      goal: createRuntimeGoal({ objective: '继续 Claude 目标', status: 'active' }),
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
        goal: createRuntimeGoal({ objective: '继续 Claude 目标', status: 'paused' }),
      }),
      setRuntimeGoal,
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('paused')
    )
    await userEvent.click(screen.getByText('resume runtime goal'))

    await waitFor(() =>
      expect(sendRuntimeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          address: expect.objectContaining({
            taskId: 'runtime-a',
          }),
          initialGoal: {
            objective: '继续 Claude 目标',
            status: 'active',
            tokenBudget: null,
          },
          message: '继续 Claude 目标',
        })
      )
    )
    expect(setRuntimeGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        address: expect.objectContaining({
          taskId: 'runtime-a',
        }),
        status: 'active',
      })
    )
  })

  test('accepts current runtime stream blocks with their full task address', async () => {
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
        deviceId: 'device-1',
      })
    })

    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent('正在思考')

    await act(async () => {
      streamHandlers?.onBlockCreated?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
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

  test('routes top-level runtime stream lifecycle events through the shared store', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (handlers.onChatStart) streamHandlers = handlers
      return vi.fn()
    })
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
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'codex',
                      running: false,
                      status: 'done',
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
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbenchWithLifecycleCoordinator(<RuntimeTopLevelStreamLifecycleProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('top-level-runtime-stream-lifecycle')).toHaveTextContent(
        'idle:idle'
      )
    )
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())

    act(() => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
    })
    expect(screen.getByTestId('top-level-runtime-stream-lifecycle')).toHaveTextContent(
      'running:streaming'
    )

    act(() => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('top-level-runtime-stream-lifecycle')).toHaveTextContent(
        'idle:idle'
      )
    )

    act(() => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '102',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })
    expect(screen.getByTestId('top-level-runtime-stream-lifecycle')).toHaveTextContent(
      'running:streaming'
    )

    act(() => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '102',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('top-level-runtime-stream-lifecycle')).toHaveTextContent(
        'idle:idle'
      )
    )
  })

  test('keeps board status writes out of renderer lifecycle reconciliation', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (handlers.onChatStart) streamHandlers = handlers
      return vi.fn()
    })
    const updateTaskTrackingStatus = vi.fn().mockResolvedValue(null)
    const updateTaskTrackingTitle = vi.fn().mockResolvedValue(null)
    const initialRuntimeWork = createRuntimeWork({
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
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'codex',
                  running: false,
                  status: 'active',
                  completedAt: 1_786_686_568_931,
                },
                {
                  taskId: 'runtime-b',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime B',
                  runtime: 'codex',
                  running: false,
                  status: 'done',
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 2,
    })
    const settledRuntimeWork = createRuntimeWork({
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
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'codex',
                  running: false,
                  status: 'active',
                  completedAt: 1_786_686_568_932,
                },
                {
                  taskId: 'runtime-b',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Stale Runtime B',
                  runtime: 'codex',
                  running: false,
                  status: 'done',
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 2,
    })
    const listRuntimeWork = vi
      .fn()
      .mockResolvedValueOnce(initialRuntimeWork)
      .mockResolvedValue(settledRuntimeWork)
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
      projectSpaceApis: {
        local: { updateTaskTrackingStatus, updateTaskTrackingTitle },
      } as unknown as WorkbenchServices['projectSpaceApis'],
    })

    renderWorkbench(
      <>
        <RuntimeTopLevelStreamLifecycleProbe />
        <RuntimePaneSendProbe />
      </>,
      services
    )
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())
    await waitFor(() => expect(listRuntimeWork).toHaveBeenCalledTimes(1))
    expect(updateTaskTrackingStatus).not.toHaveBeenCalled()

    act(() => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
    })

    act(() => {
      streamHandlers.onRuntimeTaskTitleUpdated?.({
        taskId: 'runtime-a',
        subtaskId: 'friendly-title',
        deviceId: 'device-1',
        title: '修复登录回调',
      })
    })
    await waitFor(() =>
      expect(updateTaskTrackingTitle).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'device-1', taskId: 'runtime-a' }),
        '修复登录回调'
      )
    )

    act(() => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })
    expect(updateTaskTrackingStatus).not.toHaveBeenCalled()
    await waitFor(() => expect(listRuntimeWork).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('runtime-local-task-titles')).toHaveTextContent(
      '修复登录回调|Runtime B'
    )
    expect(screen.getByTestId('runtime-local-task-titles')).not.toHaveTextContent('Stale Runtime B')
    expect(screen.getByTestId('runtime-a-task-status')).toHaveTextContent('done')
  })

  test('does not write board status while restoring runtime state', async () => {
    const updateTaskTrackingStatus = vi.fn().mockResolvedValue(null)
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
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'codex',
                      running: true,
                      status: 'running',
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
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      projectSpaceApis: {
        local: {
          updateTaskTrackingStatus,
          updateTaskTrackingTitle: vi.fn().mockResolvedValue(null),
        },
      } as unknown as WorkbenchServices['projectSpaceApis'],
    })

    renderWorkbench(<RuntimeTopLevelStreamLifecycleProbe />, services)

    await waitFor(() => expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(1))
    expect(updateTaskTrackingStatus).not.toHaveBeenCalled()
  })

  test('routes task titles to the project store recorded in the runtime handle', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (handlers.onRuntimeTaskTitleUpdated) streamHandlers = handlers
      return vi.fn()
    })
    const updateLocalTaskStatus = vi.fn().mockResolvedValue(null)
    const updateCloudTaskStatus = vi.fn().mockResolvedValue(null)
    const updateLocalTaskTitle = vi.fn().mockResolvedValue(null)
    const updateCloudTaskTitle = vi.fn().mockResolvedValue(null)
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'local-device',
                  workspacePath: '/workspace/project-alpha',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-cloud',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Cloud Issue task',
                      runtime: 'codex',
                      running: true,
                      status: 'running',
                      runtimeHandle: {
                        origin: {
                          type: 'board_task',
                          cloudProjectId: 'cloud-project',
                          loopItemId: 'ISSUE-1',
                          projectStore: 'backend',
                        },
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
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
      projectSpaceApis: {
        local: {
          updateTaskTrackingStatus: updateLocalTaskStatus,
          updateTaskTrackingTitle: updateLocalTaskTitle,
        },
        cloud: {
          updateTaskTrackingStatus: updateCloudTaskStatus,
          updateTaskTrackingTitle: updateCloudTaskTitle,
        },
        defaultLocation: 'cloud',
      } as unknown as WorkbenchServices['projectSpaceApis'],
    })

    renderWorkbench(<RuntimeTopLevelStreamLifecycleProbe />, services)

    await waitFor(() => expect(streamHandlers.onRuntimeTaskTitleUpdated).toBeDefined())
    expect(updateCloudTaskStatus).not.toHaveBeenCalled()
    expect(updateLocalTaskStatus).not.toHaveBeenCalled()

    act(() => {
      streamHandlers.onRuntimeTaskTitleUpdated?.({
        taskId: 'runtime-cloud',
        subtaskId: 'Cloud title',
        deviceId: 'local-device',
        title: 'Cloud title',
      })
    })

    await waitFor(() =>
      expect(updateCloudTaskTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'local-device',
          taskId: 'runtime-cloud',
        }),
        'Cloud title'
      )
    )
    expect(updateLocalTaskTitle).not.toHaveBeenCalled()
  })

  test('does not backfill historical runtime tasks into My Tasks during load', async () => {
    const updateTaskTrackingStatus = vi.fn().mockResolvedValue({
      id: 'WORK-1',
      status: 'in_review',
    })
    const trackProjectTask = vi.fn().mockResolvedValue({
      item: {
        id: 'WORK-1',
        cloud_project_id: 'default-work-items',
        title: 'Runtime A',
      },
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, key: 'wegent', name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  workspacePath: '/workspace/project-alpha',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'codex',
                    },
                    {
                      taskId: 'runtime-bound',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Already bound',
                      runtime: 'codex',
                      status: 'queued',
                      runtimeHandle: {
                        cloudProjectId: 'project-1',
                        loopItemId: 'WEG-1',
                      },
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 2,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      projectSpaceApis: {
        local: {
          trackProjectTask,
          updateTaskTrackingStatus,
          updateTaskTrackingTitle: vi.fn().mockResolvedValue(null),
        },
      } as unknown as WorkbenchServices['projectSpaceApis'],
    })

    renderWorkbench(<div />, services)

    await waitFor(() => expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(1))
    expect(trackProjectTask).not.toHaveBeenCalled()
    expect(updateTaskTrackingStatus).not.toHaveBeenCalled()
  })

  test('polls the cloud executor until idle when the cached snapshot predates the active turn', async () => {
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
    let executorSettling = false
    let settleSnapshotReads = 0
    const firstSettlementRead = deferred<RuntimeWorkListResponse>()
    const listRuntimeWork = vi.fn().mockResolvedValue(idleRuntimeWork)
    const listCloudRuntimeWork = vi.fn().mockImplementation(() => {
      if (!executorSettling) return Promise.resolve(idleRuntimeWork)
      settleSnapshotReads += 1
      return settleSnapshotReads === 1
        ? firstSettlementRead.promise
        : Promise.resolve(idleRuntimeWork)
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork,
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
      cloudBackgroundApi: {
        listRuntimeWork: listCloudRuntimeWork,
      },
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbenchWithLifecycleCoordinator(
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

    const cloudListCallsBeforeSettlement = listCloudRuntimeWork.mock.calls.length
    executorSettling = true
    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    await waitFor(() =>
      expect(listCloudRuntimeWork.mock.calls.length).toBeGreaterThan(cloudListCallsBeforeSettlement)
    )
    expect(sendRuntimeMessage).not.toHaveBeenCalled()

    await act(async () => {
      firstSettlementRead.resolve(runningRuntimeWork)
      await firstSettlementRead.promise
    })
    expect(sendRuntimeMessage).not.toHaveBeenCalled()

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(settleSnapshotReads).toBeGreaterThanOrEqual(2)
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientUserMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
    })
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('sending:继续修')
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '102',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))
  })

  test('uses the transcript to settle an ephemeral task omitted from runtime work', async () => {
    const streamHandlers: ChatStreamHandlers[] = []
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers.push(handlers)
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const emptyRuntimeWork = createRuntimeWork({
      projects: [],
      chats: [],
      totalTasks: 0,
    })
    let executorSettling = false
    const listRuntimeWork = vi.fn().mockResolvedValue(emptyRuntimeWork)
    const getRuntimeTranscript = vi.fn().mockImplementation(() =>
      Promise.resolve({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
        running: !executorSettling,
        turns: [],
      })
    )
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({
        listRuntimeWork,
        getRuntimeTranscript,
        sendRuntimeMessage,
      }) as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {
        listRuntimeWork,
      },
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <EphemeralRuntimeLifecycleProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open ephemeral runtime'))
    await waitFor(() => expect(streamHandlers.some(handlers => handlers.onChatStart)).toBe(true))
    act(() => {
      for (const handlers of streamHandlers) {
        handlers.onChatStart?.({
          taskId: 'runtime-a',
          subtaskId: '101',
          shellType: 'Chat',
          deviceId: 'device-1',
        })
      }
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')

    executorSettling = true
    act(() => {
      for (const handlers of streamHandlers) {
        handlers.onChatDone?.({
          taskId: 'runtime-a',
          subtaskId: '101',
          deviceId: 'device-1',
          result: { value: 'done' },
        })
      }
    })

    await waitFor(() =>
      expect(getRuntimeTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'device-1',
          taskId: 'runtime-a',
          refresh: true,
        })
      )
    )
    await waitFor(() => expect(screen.getByTestId('follow-up-pane-busy')).toHaveTextContent('idle'))
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
  })

  test('ignores a superseded executor settlement snapshot response', async () => {
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
    const staleIdleRefresh = deferred<RuntimeWorkListResponse>()
    let settlementPolling = false
    let settlementReads = 0
    const listRuntimeWork = vi.fn().mockImplementation(() => {
      if (!settlementPolling) return Promise.resolve(runningRuntimeWork)
      settlementReads += 1
      return settlementReads === 1 ? staleIdleRefresh.promise : Promise.resolve(runningRuntimeWork)
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({
        listRuntimeWork,
      }) as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimeTopLevelStreamLifecycleProbe />, services)
    await waitFor(() => expect(streamHandlers.onChatDone).toBeDefined())
    await waitFor(() =>
      expect(screen.getByTestId('top-level-runtime-stream-lifecycle')).toHaveTextContent(
        'running:idle'
      )
    )

    settlementPolling = true
    act(() => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })
    await waitFor(() => expect(settlementReads).toBe(1))

    act(() => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '102',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })
    await waitFor(() => expect(settlementReads).toBeGreaterThanOrEqual(2))

    await act(async () => {
      staleIdleRefresh.resolve(idleRuntimeWork)
      await staleIdleRefresh.promise
    })
    await waitFor(() =>
      expect(listRuntimeWork.mock.settledResults.length).toBe(listRuntimeWork.mock.calls.length)
    )
    await waitFor(() =>
      expect(screen.getByTestId('top-level-runtime-stream-lifecycle')).toHaveTextContent(
        'running:idle'
      )
    )
  })

  test('waits for executor idle before sending a queued image message', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    let providerHasActiveTurn = true
    const sendRuntimeMessage = vi.fn().mockImplementation(() =>
      Promise.resolve(
        providerHasActiveTurn
          ? {
              accepted: false,
              taskId: 'runtime-a',
              error: 'runtime task is already running',
            }
          : {
              accepted: true,
              taskId: 'runtime-a',
            }
      )
    )
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
                  running: providerHasActiveTurn,
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockImplementation(() =>
        Promise.resolve({
          ...runningRuntimeWork,
          projects: runningRuntimeWork.projects.map(project => ({
            ...project,
            deviceWorkspaces: project.deviceWorkspaces.map(workspace => ({
              ...workspace,
              tasks: workspace.tasks.map(task => ({
                ...task,
                running: providerHasActiveTurn,
              })),
            })),
          })),
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
    await userEvent.click(screen.getByText('add image attachment'))
    await userEvent.click(screen.getByText('send follow-up'))

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    expect(screen.getByTestId('queued-errors')).toHaveTextContent('')
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('继续修')

    providerHasActiveTurn = false
    await userEvent.click(screen.getByText('refresh work lists'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage.mock.calls[0][0].attachmentIds).toEqual([45])
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('sending:继续修')
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '102',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))
    expect(screen.getByTestId('queued-errors')).toHaveTextContent('')
    expect(screen.getByTestId('runtime-open-messages').textContent?.match(/继续修/g)).toHaveLength(
      1
    )
  })

  test('refreshes stale idle state and queues a follow-up rejected by an active provider turn', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    let providerHasActiveTurn = false
    const runtimeWork = (running: boolean) =>
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
                    running,
                    continuable: true,
                    status: running ? 'running' : 'active',
                  },
                ],
              },
            ],
          },
        ],
        totalTasks: 1,
      })
    const sendRuntimeMessage = vi
      .fn()
      .mockImplementationOnce(async () => {
        providerHasActiveTurn = true
        return {
          accepted: false,
          taskId: 'runtime-a',
          error: 'runtime task is already running',
        }
      })
      .mockResolvedValue({
        accepted: true,
        taskId: 'runtime-a',
      })
    const listRuntimeWork = vi
      .fn()
      .mockImplementation(() => Promise.resolve(runtimeWork(providerHasActiveTurn)))
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork,
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
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
    await waitFor(() => expect(screen.getByTestId('follow-up-pane-busy')).toHaveTextContent('idle'))
    const listCallsBeforeSend = listRuntimeWork.mock.calls.length

    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    )
    await waitFor(() =>
      expect(listRuntimeWork.mock.calls.length).toBeGreaterThan(listCallsBeforeSend)
    )
    await waitFor(() => expect(screen.getByTestId('follow-up-pane-busy')).toHaveTextContent('busy'))

    providerHasActiveTurn = false
    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('sending:继续修')
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '102',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))
    expect(screen.getByTestId('runtime-open-messages').textContent?.match(/继续修/g)).toHaveLength(
      1
    )
  })

  test('keeps a direct busy rejection queued until the task lifecycle changes', async () => {
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
                  deviceId: 'device-1',
                  available: true,
                  workspacePath: '/workspace/project-alpha',
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
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const uploadLocalAttachmentToCloud = vi
      .fn()
      .mockRejectedValueOnce(new Error('runtime task is already running'))
      .mockResolvedValue(createImageAttachment({ id: 46 }))
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      attachmentApi: {
        uploadAttachment: vi.fn(),
        uploadLocalAttachmentToCloud,
      },
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbenchWithLifecycleCoordinator(
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

    await waitFor(() =>
      expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    )
    expect(uploadLocalAttachmentToCloud).toHaveBeenCalledTimes(1)
    expect(sendRuntimeMessage).not.toHaveBeenCalled()

    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: 'provider-active-turn',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    expect(uploadLocalAttachmentToCloud).toHaveBeenCalledTimes(1)
    expect(sendRuntimeMessage).not.toHaveBeenCalled()

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: 'provider-active-turn',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    await waitFor(() => expect(uploadLocalAttachmentToCloud).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('sending:继续修')
  })

  test('retries a busy rejection when its blocking turn settles before the response returns', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const busyResponse = deferred<{
      accepted: boolean
      taskId: string
      error?: string
    }>()
    const sendRuntimeMessage = vi.fn().mockReturnValueOnce(busyResponse.promise).mockResolvedValue({
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
                  deviceId: 'device-1',
                  available: true,
                  workspacePath: '/workspace/project-alpha',
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
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
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

    renderWorkbenchWithLifecycleCoordinator(
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
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))

    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: 'provider-active-turn',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: 'provider-active-turn',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    await act(async () => {
      busyResponse.resolve({
        accepted: false,
        taskId: 'runtime-a',
        error: 'runtime task is already running',
      })
      await busyResponse.promise
    })

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('sending:继续修')
  })

  test('retries a queued busy rejection when another turn settles before the response returns', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const busyResponse = deferred<{
      accepted: boolean
      taskId: string
      error?: string
    }>()
    const sendRuntimeMessage = vi.fn().mockReturnValueOnce(busyResponse.promise).mockResolvedValue({
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
                  deviceId: 'device-1',
                  available: true,
                  workspacePath: '/workspace/project-alpha',
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
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
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

    renderWorkbenchWithLifecycleCoordinator(
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
        subtaskId: 'initial-turn',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    expect(sendRuntimeMessage).not.toHaveBeenCalled()

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: 'initial-turn',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))

    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: 'provider-active-turn',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: 'provider-active-turn',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    await act(async () => {
      busyResponse.resolve({
        accepted: false,
        taskId: 'runtime-a',
        error: 'runtime task is already running',
      })
      await busyResponse.promise
    })

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('sending:继续修')
  })

  test('waits for the sent queued runtime message to start before sending the next queued item', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const firstQueuedSend = deferred<{ accepted: boolean; taskId: string }>()
    const sendRuntimeMessage = vi
      .fn()
      .mockReturnValueOnce(firstQueuedSend.promise)
      .mockResolvedValue({
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

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    runtimeRunning = false
    await userEvent.click(screen.getByText('refresh work lists'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientUserMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
    })
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('sending:继续修|queued:执行ls')

    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 50))
    })
    expect(sendRuntimeMessage).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByText('open follow-up runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-current-runtime-task')).toHaveTextContent(
        'device-1:runtime-b'
      )
    )
    expect(screen.getByTestId('queued-messages')).toBeEmptyDOMElement()

    runtimeRunning = true
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '102',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    expect(sendRuntimeMessage).toHaveBeenCalledTimes(1)
    firstQueuedSend.resolve({
      accepted: true,
      taskId: 'runtime-a',
    })
    await act(async () => {
      await firstQueuedSend.promise
    })
    expect(
      getRuntimeConversationQueuedMessages({
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      })
    ).toEqual([expect.objectContaining({ content: '执行ls', status: 'queued' })])

    runtimeRunning = false
    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '102',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    await userEvent.click(screen.getByText('open follow-up runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-current-runtime-task')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(2))
    expect(sendRuntimeMessage.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        message: '执行ls',
      })
    )
  })

  test('drains the preserved queue when a manual turn settles before React commits', async () => {
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
              deviceId: 'device-1',
              available: true,
              workspacePath: '/workspace/project-alpha',
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
              deviceId: 'device-1',
              available: true,
              workspacePath: '/workspace/project-alpha',
              tasks: [
                {
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'claude_code',
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
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const cancelRuntimeTask = vi.fn().mockImplementation(() => {
      runtimeRunning = false
      return Promise.resolve({
        accepted: true,
        taskId: 'runtime-a',
      })
    })
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
      cancelRuntimeTask,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbenchWithLifecycleCoordinator(
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
        subtaskId: 'active-turn',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() =>
      expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    )
    await userEvent.click(screen.getByText('stop current response'))
    await waitFor(() => expect(cancelRuntimeTask).toHaveBeenCalledTimes(1))
    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: 'active-turn',
        deviceId: 'device-1',
        result: { error: 'cancelled' },
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('queued-messages-paused')).toHaveTextContent('paused')
    )
    await waitFor(() => expect(screen.getByTestId('follow-up-pane-busy')).toHaveTextContent('idle'))

    await userEvent.click(screen.getByText('resume queue with manual input'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        message: '手动消息',
      })
    )
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    expect(screen.getByTestId('queued-messages-paused')).toHaveTextContent('paused')

    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: 'manual-turn',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    expect(sendRuntimeMessage).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('queued-messages-paused')).toHaveTextContent('paused')

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: 'manual-turn',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('queued-messages-paused')).toHaveTextContent('running')
    )
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(2))
    expect(sendRuntimeMessage.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        message: '继续修',
      })
    )
  })

  test('clears a queued message when its turn starts before the send request resolves', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const queuedSend = deferred<{ accepted: boolean; taskId: string }>()
    const sendRuntimeMessage = vi.fn().mockReturnValue(queuedSend.promise)
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  available: true,
                  workspacePath: '/workspace/project-alpha',
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

    renderWorkbenchWithLifecycleCoordinator(
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
    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('sending:继续修')
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '102',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await act(async () => {
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-a',
        subtaskId: '102',
        deviceId: 'device-1',
        itemId: 'assistant-102',
        offset: 0,
        content: '已经继续修了',
      })
    })
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('sending:继续修')

    await act(async () => {
      queuedSend.resolve({
        accepted: true,
        taskId: 'runtime-a',
      })
      await queuedSend.promise
    })
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toBeEmptyDOMElement())
    expect(screen.getByTestId('follow-up-messages')).toHaveTextContent(
      'user:继续修|assistant:已经继续修了'
    )
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
            subtaskId: '101',
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
        itemId: 'assistant-before-guidance',
        content: 'before ',
        offset: 0,
        deviceId: 'device-1',
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
        'first message|working\n\nbefore '
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
    expect(screen.getByTestId('queued-guidance-acceptance')).toHaveTextContent('pending')
    expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
      'first message|working\n\nbefore '
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
    expect(screen.getByTestId('queued-guidance-acceptance')).toHaveTextContent('accepted')
    expect(screen.getByTestId('runtime-open-blocks')).not.toHaveTextContent(
      'tool:conversation_guidance:done'
    )

    await act(async () => {
      streamHandlers.onGuidanceApplied?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        guidanceId: 'raw-guidance-item',
        clientGuidanceId: queuedMessageId ?? undefined,
        message: '继续修',
        appliedAtMs: Date.now(),
      })
    })
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))
    expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
      'first message|working\n\nbefore |继续修|'
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
      'tool:conversation_guidance:done'
    )
    expect(screen.getByTestId('runtime-open-message-ids')).toHaveTextContent(queuedMessageId ?? '')

    await act(async () => {
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        itemId: 'assistant-after-guidance',
        content: 'after',
        offset: 0,
        deviceId: 'device-1',
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
        'first message|working\n\nbefore |继续修|after'
      )
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
      'tool:conversation_guidance:done'
    )
    await act(async () => {
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        itemId: 'assistant-after-guidance',
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
        'first message|working\n\nbefore |继续修|after more'
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
            subtaskId: '101',
          },
        ],
      }),
      sendRuntimeMessage,
      guideRuntimeTask,
      setRuntimeGoal,
    })
    const uploadLocalAttachmentToCloud = vi
      .fn()
      .mockResolvedValue(createImageAttachment({ id: 46 }))
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      attachmentApi: {
        uploadAttachment: vi.fn(),
        uploadLocalAttachmentToCloud,
      },
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
    await userEvent.click(screen.getByText('set follow-up goal'))
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('add local image attachment'))
    await userEvent.click(screen.getByTestId('capture-idle-follow-up-send'))
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('send follow-up as guidance'))
    const queuedMessageId = screen.getByTestId('queued-message-ids').textContent

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
        clientGuidanceId: queuedMessageId ?? undefined,
        message: '继续修',
        appliedAtMs: Date.now(),
      })
    })
    expect(guideRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '继续修',
        attachmentIds: [46],
        attachments: [
          expect.objectContaining({
            id: 46,
            filename: 'photo.png',
            mime_type: 'image/png',
          }),
        ],
      })
    )
    expect(uploadLocalAttachmentToCloud).toHaveBeenCalledWith(
      expect.objectContaining({
        local_path: LOCAL_IMAGE_ATTACHMENT_PATH,
        mime_type: 'image/png',
      })
    )
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('')
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-goal-flags')).toHaveTextContent('goal:继续修')
    expect(screen.getByTestId('runtime-open-message-ids')).toHaveTextContent('queued-runtime-pane-')
  })

  test('starts a queued Goal turn after the active response settles', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const goalLoad = deferred<RuntimeGoalGetResponse>()
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
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
                      runtime: 'codex',
                      running: true,
                      continuable: true,
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
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
            subtaskId: '101',
          },
        ],
      }),
      getRuntimeGoal: vi.fn().mockReturnValue(goalLoad.promise),
      sendRuntimeMessage,
      setRuntimeGoal,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbenchWithLifecycleCoordinator(
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
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() =>
      expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    )
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(setRuntimeGoal).not.toHaveBeenCalled()
    expect(screen.getByTestId('follow-up-pane-busy')).toHaveTextContent('busy')
    expect(screen.getByTestId('runtime-goal-objective')).toHaveTextContent('继续修')

    await act(async () => {
      goalLoad.resolve({
        accepted: true,
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        goal: null,
      })
      await goalLoad.promise
    })
    expect(screen.getByTestId('runtime-goal-objective')).toHaveTextContent('继续修')

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
      clientUserMessageId: expect.any(String),
      initialGoal: expect.objectContaining({
        objective: '继续修',
        status: 'active',
      }),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
    })
    expect(screen.getByTestId('follow-up-pane-busy')).toHaveTextContent('busy')
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
    const interruptedGuidanceId = screen.getByTestId('queued-message-ids').textContent ?? ''

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
        itemId: 'assistant-replacement',
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
      streamHandlers.onGuidanceApplied?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        guidanceId: 'raw-guidance-item',
        message: '继续修',
        appliedAtMs: Date.now(),
      })
    })
    expect(
      getRuntimeConversationMessages({
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      })
    ).not.toContainEqual(
      expect.objectContaining({
        id: interruptedGuidanceId,
        runtimeGuidance: true,
      })
    )

    await act(async () => {
      interruptResult.resolve({ accepted: true, taskId: 'runtime-a' })
    })
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))

    await act(async () => {
      guidanceResult.resolve({
        accepted: true,
        success: true,
        taskId: 'runtime-a',
        guidanceId: 'raw-guidance-item',
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

  test('sends failed queued work directly when the active turn is unavailable', async () => {
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
    const executorRunning = true
    let turnRunning = true
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockImplementation(() =>
        Promise.resolve(
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
                        running: executorRunning,
                      },
                    ],
                  },
                ],
              },
            ],
            totalTasks: 1,
          })
        )
      ),
      getRuntimeTranscript: vi.fn().mockImplementation(() =>
        Promise.resolve({
          taskId: 'runtime-a',
          workspacePath: '/workspace/project-alpha',
          runtime: 'claude_code',
          running: turnRunning,
          messages: [
            { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
            {
              id: 'runtime-a:assistant:1',
              role: 'assistant',
              content: turnRunning ? 'working' : 'done',
              status: turnRunning ? 'streaming' : 'done',
              subtaskId: '101',
            },
          ],
        })
      ),
      sendRuntimeMessage,
      guideRuntimeTask,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbenchWithLifecycleCoordinator(
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

    turnRunning = false
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
    expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('idle')

    await userEvent.click(screen.getByText('guide first queued'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(2))
    expect(guideRuntimeTask).not.toHaveBeenCalled()
    expect(sendRuntimeMessage).toHaveBeenLastCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientUserMessageId: expect.any(String),
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
            subtaskId: '101',
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

  test('marks a pending turn stopped when cancellation wins the assistant-start race', async () => {
    let runtimeRunning = false
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
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
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
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    const listRuntimeWork = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(runtimeRunning ? runningRuntimeWork : idleRuntimeWork)
      )
    const sendRuntimeMessage = vi.fn().mockImplementation(() => {
      runtimeRunning = true
      return Promise.resolve({
        accepted: true,
        taskId: 'runtime-a',
      })
    })
    const cancellation = deferred<{ accepted: boolean; taskId: string }>()
    const cancelRuntimeTask = vi.fn().mockImplementation(async () => {
      const response = await cancellation.promise
      runtimeRunning = false
      return response
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork,
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
      cancelRuntimeTask,
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
    expect(screen.getByTestId('runtime-message-statuses')).not.toHaveTextContent('assistant:')
    expect(screen.queryByTestId('assistant-stopped-notice')).not.toBeInTheDocument()

    await userEvent.click(screen.getByText('stop current response'))

    await waitFor(() => expect(cancelRuntimeTask).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('assistant-stopped-notice')).not.toBeInTheDocument()

    cancellation.resolve({
      accepted: true,
      taskId: 'runtime-a',
    })
    await waitFor(() => expect(screen.getByTestId('assistant-stopped-notice')).toBeInTheDocument())
    expect(screen.getByTestId('assistant-stopped-notice')).toHaveTextContent('已停止')
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
    const queuedMessageId = screen.getByTestId('queued-message-ids').textContent

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
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('执行ls')
    await act(async () => {
      streamHandlers.onGuidanceApplied?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        guidanceId: 'raw-guidance-item',
        clientGuidanceId: queuedMessageId ?? undefined,
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
      clientUserMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
      attachmentIds: [45],
    })
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-error')).toHaveTextContent('')
  })

  test('uploads local image attachments before cloud runtime task follow-up messages', async () => {
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
    const uploadLocalAttachmentToCloud = vi
      .fn()
      .mockResolvedValue(createImageAttachment({ id: 46 }))
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      attachmentApi: {
        uploadAttachment: vi.fn(),
        uploadLocalAttachmentToCloud,
      },
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
    expect(uploadLocalAttachmentToCloud).toHaveBeenCalledWith(
      expect.objectContaining({
        id: -45,
        filename: 'photo.png',
        local_path: LOCAL_IMAGE_ATTACHMENT_PATH,
      })
    )
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientUserMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
      attachmentIds: [46],
      attachments: [
        expect.objectContaining({
          id: 46,
          filename: 'photo.png',
          mime_type: 'image/png',
        }),
      ],
    })
  })

  test('loads local skills and apps from Codex app-server', async () => {
    setElectronRuntime()
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
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        itemId: 'stale-runtime-a-message',
        content: 'stale runtime a output',
        offset: 0,
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
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-b',
        subtaskId: '102',
        itemId: 'current-runtime-b-message',
        content: 'current runtime b output',
        offset: 0,
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
