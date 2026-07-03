import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createContext, StrictMode, useContext, useEffect, useMemo, useState } from 'react'
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
import { useWorkbenchPaneSession } from '@/components/layout/useWorkbenchPaneSession'
import { parseRuntimeTaskRoute } from '@/lib/navigation'
import { findRuntimeTask } from './workbenchRuntimeHelpers'
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
  RuntimeGoal,
  RuntimeTranscriptResponse,
  RuntimeTranscriptRequest,
  TurnFileChangesSummary,
  RuntimeWorkListResponse,
  UnifiedModel,
  User,
} from '@/types/api'

const localExecutorMocks = vi.hoisted(() => ({
  ensureLocalExecutorStarted: vi.fn(),
  requestLocalExecutor: vi.fn(),
  subscribeLocalExecutorEvents: vi.fn(),
}))

vi.mock('@/tauri/localExecutor', () => ({
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
                taskId: 77,
                taskId: 'runtime-a',
                workspacePath: '/workspace/project-alpha',
                title: 'Runtime A',
                runtime: 'claude_code',
              },
              {
                taskId: 88,
                taskId: 'runtime-b',
                workspacePath: '/workspace/project-alpha',
                title: 'Runtime B',
                runtime: 'claude_code',
              },
              {
                taskId: 99,
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
  '/workspace/project-alpha/.wegent/attachments/draft/-45/photo.png'

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
      taskId: 77,
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
    connectWithPassword: vi.fn(),
    setupAdminPassword: vi.fn(),
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
  const { state: workbenchState, openRuntimeTask } = workbench
  const routeRuntimeTask = useMemo(() => {
    if (workbenchState.isBootstrapping || workbenchState.currentRuntimeTask) return null
    const route = parseRuntimeTaskRoute(window.location.pathname, window.location.search)
    if (!route) return null
    const localTask = findRuntimeTask(workbenchState.runtimeWork, route)
    return {
      ...route,
      ...(localTask?.workspacePath ? { workspacePath: localTask.workspacePath } : {}),
    }
  }, [
    workbenchState.currentRuntimeTask,
    workbenchState.isBootstrapping,
    workbenchState.runtimeWork,
  ])
  const currentRuntimeTask = workbenchState.currentRuntimeTask ?? routeRuntimeTask

  useEffect(() => {
    if (workbenchState.isBootstrapping || workbenchState.currentRuntimeTask || !routeRuntimeTask) {
      return
    }
    void openRuntimeTask(routeRuntimeTask)
  }, [
    routeRuntimeTask,
    openRuntimeTask,
    workbenchState.currentRuntimeTask,
    workbenchState.isBootstrapping,
  ])

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

function ProjectSendProbe() {
  const { workbench, paneSession, currentRuntimeTask } = useWorkbenchProbeSession()
  const imageAttachment = createImageAttachment()
  const localImageAttachment = createLocalImageAttachment()

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
      <span data-testid="runtime-project-order">
        {workbench.state.runtimeWork?.projects
          .map(projectWork => projectWork.project.name)
          .join('|') ?? ''}
      </span>
      <span data-testid="project-attachment-count">{workbench.projectChat.attachments.length}</span>
      <span data-testid="workbench-error">{workbench.state.error ?? ''}</span>
      <span data-testid="sending-state">{paneSession.sending ? 'sending' : 'idle'}</span>
      <button type="button" onClick={() => workbench.selectProjectWorkspace(7, null)}>
        select project
      </button>
      <button type="button" onClick={() => workbench.startNewChat()}>
        start new chat
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
          void workbench.openStandaloneWorkspace(
            'device-1',
            '/workspace/direct-codex',
            'Direct Codex'
          )
        }
      >
        open labeled standalone workspace
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
      <MessageList
        messages={paneSession.messages}
        isWaitingForAssistant={paneSession.status.isWaitingForAssistantIndicator}
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
            .archiveProjectsConversations(['project:7'])
            .then(result => setLastArchiveResult(result?.status ?? 'none'))
        }
      >
        archive project conversations
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench
            .archiveProjectsConversations(['project:7'], { force: true })
            .then(result => setLastArchiveResult(result?.status ?? 'none'))
        }
      >
        force archive project conversations
      </button>
    </div>
  )
}

function RuntimeOpenProbe() {
  const { workbench, paneSession, currentRuntimeTask } = useWorkbenchProbeSession()
  const [fileChangesDiff, setFileChangesDiff] = useState('')
  const [fileChangesStatus, setFileChangesStatus] = useState('')
  const fileChangesSubtaskId = paneSession.messages.find(message => message.fileChanges)?.subtaskId
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
      <span data-testid="runtime-open-goal-flags">
        {paneSession.messages
          .filter(message => message.runtimeGoalRequest === true)
          .map(message => `goal:${message.content}`)
          .join('|') || 'none'}
      </span>
      <span data-testid="runtime-message-statuses">
        {paneSession.messages.map(message => `${message.role}:${message.status}`).join('|')}
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
              .loadTurnFileChangesDiff(fileChangesSubtaskId, paneSession.messages)
              .then(setFileChangesDiff)
          }
        }}
      >
        review runtime file changes
      </button>
      <button
        type="button"
        onClick={() => {
          if (fileChangesSubtaskId) {
            void workbench
              .revertTurnFileChanges(fileChangesSubtaskId, paneSession.messages)
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

function FollowUpProbe() {
  const { workbench, paneSession } = useWorkbenchProbeSession()
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
      <span data-testid="queued-errors">
        {paneSession.queuedMessages.map(message => message.error ?? '').join('|')}
      </span>
      <span data-testid="queued-notices">
        {paneSession.queuedMessages.map(message => message.notice ?? '').join('|')}
      </span>
      <span data-testid="runtime-attachment-count">{workbench.projectChat.attachments.length}</span>
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
      <button type="button" onClick={() => paneSession.setInput('继续修')}>
        set follow-up
      </button>
      <button type="button" onClick={() => paneSession.setInput('执行ls')}>
        set ls follow-up
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
      <button type="button" onClick={() => void paneSession.send()}>
        send follow-up
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

    expect(screen.getByTestId('workbench-error')).toHaveTextContent('请输入目标内容')
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

  test('keeps the sent user message when transcript loading effects replay', async () => {
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
        subtaskId: 102,
        device_id: 'device-1',
        task_id: request.taskId,
      }
      const chunkPayload = {
        subtaskId: 102,
        content: 'streamed answer',
        offset: 0,
        device_id: 'device-1',
        task_id: request.taskId,
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
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
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
    expect(await screen.findByTestId('message-image-preview')).toHaveAttribute(
      'src',
      'blob:runtime-message-image-preview'
    )
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

  test('returns dirty result before archiving a worktree task with uncommitted changes', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: ' M src/App.tsx\n',
      stderr: '',
    })
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
      deviceApi: { executeCommand } as Partial<
        WorkbenchServices['deviceApi']
      > as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ArchiveRuntimeTaskProbe />, services)

    await waitFor(() => expect(screen.getByText('archive worktree task')).toBeInTheDocument())
    await userEvent.click(screen.getByText('archive worktree task'))

    await waitFor(() =>
      expect(screen.getByTestId('archive-result')).toHaveTextContent('dirty_worktree')
    )
    expect(screen.getByTestId('workbench-error')).toHaveTextContent('')
    expect(runtimeWorkApi.archiveConversation).not.toHaveBeenCalled()
    expect(executeCommand).toHaveBeenCalledWith('device-1', {
      command_key: 'git_status_porcelain',
      path: '/workspace/worktrees/9/project-alpha',
      timeout_seconds: 10,
      max_output_bytes: 65536,
    })
    expect(executeCommand).not.toHaveBeenCalledWith(
      'device-1',
      expect.objectContaining({ command_key: 'git_worktree_remove' })
    )
  })

  test('force archives and removes a dirty worktree task', async () => {
    const executeCommand = vi.fn().mockImplementation(async (_deviceId, data) => {
      if (data.command_key === 'git_worktree_remove') {
        return { success: true, stdout: '', stderr: '' }
      }
      throw new Error(`unexpected command: ${data.command_key}`)
    })
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
      deviceApi: { executeCommand } as Partial<
        WorkbenchServices['deviceApi']
      > as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ArchiveRuntimeTaskProbe />, services)

    await waitFor(() => expect(screen.getByText('force archive worktree task')).toBeInTheDocument())
    await userEvent.click(screen.getByText('force archive worktree task'))

    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1))
    expect(executeCommand).not.toHaveBeenCalledWith(
      'device-1',
      expect.objectContaining({ command_key: 'git_status_porcelain' })
    )
    expect(executeCommand).toHaveBeenCalledWith('device-1', {
      command_key: 'git_worktree_remove',
      path: '/workspace/worktrees/9/project-alpha',
      args: ['/workspace/worktrees/9/project-alpha', '/workspace/worktrees/9/project-alpha'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
    await waitFor(() => expect(screen.getByTestId('archive-result')).toHaveTextContent('archived'))
  })

  test('archives clean worktree tasks before removing the worktree', async () => {
    const executeCommand = vi.fn().mockImplementation(async (_deviceId, data) => {
      if (data.command_key === 'git_status_porcelain') {
        return { success: true, stdout: '', stderr: '' }
      }
      if (data.command_key === 'git_worktree_remove') {
        return { success: true, stdout: '', stderr: '' }
      }
      throw new Error(`unexpected command: ${data.command_key}`)
    })
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
      deviceApi: { executeCommand } as Partial<
        WorkbenchServices['deviceApi']
      > as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ArchiveRuntimeTaskProbe />, services)

    await waitFor(() => expect(screen.getByText('archive worktree task')).toBeInTheDocument())
    await userEvent.click(screen.getByText('archive worktree task'))

    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(executeCommand).toHaveBeenCalledWith('device-1', {
        command_key: 'git_worktree_remove',
        path: '/workspace/worktrees/9/project-alpha',
        args: ['/workspace/worktrees/9/project-alpha', '/workspace/worktrees/9/project-alpha'],
        timeout_seconds: 30,
        max_output_bytes: 8192,
      })
    )
    const removeCallOrder = executeCommand.mock.invocationCallOrder.at(-1)
    expect(runtimeWorkApi.archiveConversation.mock.invocationCallOrder[0]).toBeLessThan(
      removeCallOrder ?? 0
    )
  })

  test('prompts before force archiving project conversations with dirty worktrees', async () => {
    const executeCommand = vi.fn().mockImplementation(async (_deviceId, data) => {
      if (data.command_key === 'git_status_porcelain') {
        return { success: true, stdout: ' M src/App.tsx\n', stderr: '' }
      }
      if (data.command_key === 'git_worktree_remove') {
        return { success: true, stdout: '', stderr: '' }
      }
      throw new Error(`unexpected command: ${data.command_key}`)
    })
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
          ],
          totalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      deviceApi: { executeCommand } as Partial<
        WorkbenchServices['deviceApi']
      > as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ArchiveProjectConversationsProbe />, services)

    await waitFor(() =>
      expect(screen.getByText('archive project conversations')).toBeInTheDocument()
    )
    await userEvent.click(screen.getByText('archive project conversations'))

    await waitFor(() =>
      expect(screen.getByTestId('archive-result')).toHaveTextContent('dirty_worktree')
    )
    expect(runtimeWorkApi.archiveProjectConversations).not.toHaveBeenCalled()
    expect(executeCommand).not.toHaveBeenCalledWith(
      'device-1',
      expect.objectContaining({ command_key: 'git_worktree_remove' })
    )

    await userEvent.click(screen.getByText('force archive project conversations'))

    await waitFor(() => expect(runtimeWorkApi.archiveProjectConversations).toHaveBeenCalledTimes(1))
    expect(executeCommand).toHaveBeenCalledWith('device-1', {
      command_key: 'git_worktree_remove',
      path: '/workspace/worktrees/9/project-alpha',
      args: ['/workspace/worktrees/9/project-alpha', '/workspace/worktrees/9/project-alpha'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
    await waitFor(() => expect(screen.getByTestId('archive-result')).toHaveTextContent('archived'))
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
        taskId: 77,
        subtaskId: 102,
        shell_type: 'Codex',
        device_id: 'device-1',
        task_id: request.taskId,
      })
      streamHandlers.onChatChunk?.({
        taskId: 77,
        subtaskId: 102,
        content: 'streamed answer',
        offset: 0,
        device_id: 'device-1',
        task_id: request.taskId,
      })
    })

    expect(screen.getByTestId('message-roles')).toHaveTextContent('user:修复 CI')
    await waitFor(() =>
      expect(screen.getByTestId('message-roles')).toHaveTextContent('assistant:streamed answer')
    )

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
            subtaskId: 102,
          },
        ],
      })
      await transcript.promise
    })
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
          subtaskId: 901,
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
          subtaskId: 902,
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
            subtaskId: 901,
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
          subtaskId: 902,
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
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
    })
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('继续修')
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
        taskId: 77,
        subtaskId: 101,
        shell_type: 'Chat',
        device_id: 'device-1',
        task_id: 'runtime-a',
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
        taskId: 77,
        subtaskId: 101,
        shell_type: 'Chat',
        device_id: 'device-1',
        task_id: 'runtime-a',
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
        taskId: 77,
        subtaskId: 101,
        shell_type: 'Chat',
        device_id: 'device-1',
        task_id: 'runtime-a',
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
        taskId: 77,
        subtaskId: 101,
        shell_type: 'Chat',
        device_id: 'device-1',
        task_id: 'runtime-a',
        result: { value: 'done' },
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-goal-objective')).toHaveTextContent('none')
    )
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
        taskId: 77,
        subtaskId: 101,
        shell_type: 'Codex',
        task_id: 'runtime-a',
      })
    })

    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent('正在思考')

    await act(async () => {
      streamHandlers?.onBlockCreated?.({
        taskId: 77,
        subtaskId: 101,
        task_id: 'runtime-a',
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
        taskId: 77,
        subtaskId: 101,
        shell_type: 'Chat',
        device_id: 'device-1',
        task_id: 'runtime-a',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')

    runtimeRunning = false
    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 77,
        subtaskId: 101,
        shell_type: 'Chat',
        device_id: 'device-1',
        task_id: 'runtime-a',
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
        taskId: 77,
        subtaskId: 101,
        shell_type: 'Chat',
        device_id: 'device-1',
        task_id: 'runtime-a',
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
        taskId: 77,
        subtaskId: 101,
        shell_type: 'Chat',
        device_id: 'device-1',
        task_id: 'runtime-a',
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
        taskId: 77,
        subtaskId: 101,
        shell_type: 'Chat',
        device_id: 'device-1',
        task_id: 'runtime-a',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('edit first queued'))

    expect(screen.getByTestId('composer-input')).toHaveTextContent('继续修')
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('')
  })

  test('pauses the active runtime task before sending queued guidance', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
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
        taskId: 77,
        subtaskId: 101,
        shell_type: 'Chat',
        device_id: 'device-1',
        task_id: 'runtime-a',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('guide first queued'))

    await waitFor(() => expect(cancelRuntimeTask).toHaveBeenCalledTimes(1))
    expect(cancelRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      taskId: 'runtime-a',
    })
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
    })
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('')
    expect(screen.getByTestId('guidance-messages')).toHaveTextContent('')
  })

  test('refreshes runtime work after cancelling the active runtime task', async () => {
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
      runtimeRunning = false
      return Promise.resolve({
        accepted: true,
        taskId: 'runtime-a',
      })
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
        taskId: 77,
        subtaskId: 101,
        shell_type: 'Chat',
        device_id: 'device-1',
        task_id: 'runtime-a',
      })
    })
    const listCallsBeforeCancel = listRuntimeWork.mock.calls.length
    await userEvent.click(screen.getByText('stop current response'))

    await waitFor(() => expect(cancelRuntimeTask).toHaveBeenCalledTimes(1))
    expect(cancelRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      taskId: 'runtime-a',
    })
    await waitFor(() => expect(listRuntimeWork).toHaveBeenCalledTimes(listCallsBeforeCancel + 1))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('idle')
    )
    await waitFor(() =>
      expect(screen.getByTestId('runtime-message-statuses')).not.toHaveTextContent(
        'assistant:streaming'
      )
    )
  })

  test('pauses the active runtime task before sending queued guidance without DB task context', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
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
        subtaskId: 101,
        shell_type: 'Codex',
        device_id: 'device-1',
        task_id: 'runtime-a',
      })
    })
    await userEvent.click(screen.getByText('set ls follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('guide first queued'))

    await waitFor(() => expect(cancelRuntimeTask).toHaveBeenCalledTimes(1))
    expect(cancelRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      taskId: 'runtime-a',
    })
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      message: '执行ls',
      modelOptions: { collaborationMode: 'default' },
    })
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('')
    expect(screen.getByTestId('queued-errors')).not.toHaveTextContent('当前回复缺少引导上下文')
    expect(screen.getByTestId('guidance-messages')).toHaveTextContent('')
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('执行ls')
    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent('正在思考')
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

  test('loads local skills from the current runtime task device', async () => {
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi
          .fn()
          .mockResolvedValue([
            createDevice({ device_id: 'device-1', name: 'Default Device' }),
            createDevice({ id: 2, device_id: 'runtime-device', name: 'Runtime Device' }),
          ]),
        listSkills: vi.fn().mockResolvedValue([
          {
            name: 'env-context',
            description: 'Environment facts',
            path: '/Users/crystal/.codex/skills/env-context/SKILL.md',
            source: 'codex',
          },
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
      expect(services.deviceApi.listSkills).toHaveBeenCalledWith('runtime-device')
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
        subtaskId: 101,
        shell_type: 'Codex',
        device_id: 'device-1',
        task_id: 'runtime-a',
      })
      streamHandlers.onChatDone?.({
        subtaskId: 101,
        offset: 0,
        result: { value: 'stale runtime a output' },
        device_id: 'device-1',
        task_id: 'runtime-a',
      })
      streamHandlers.onChatStart?.({
        subtaskId: 102,
        shell_type: 'Codex',
        device_id: 'device-1',
        task_id: 'runtime-b',
      })
      streamHandlers.onChatDone?.({
        subtaskId: 102,
        offset: 0,
        result: { value: 'current runtime b output' },
        device_id: 'device-1',
        task_id: 'runtime-b',
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
