import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import { createDeviceApi } from '@/api/devices'
import { getLocalCodexUsageDisplay } from '@/api/local/codexUsage'
import { createProjectApi } from '@/api/projects'
import { AuthContext } from '@/features/auth/useAuth'
import { WorkbenchContext, WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type {
  WorkbenchContextValue,
  WorkbenchPaneContextValue,
} from '@/features/workbench/workbenchContextTypes'
import { openExternalUrl } from '@/lib/external-links'
import {
  closeLocalTerminal,
  getLocalExecutorDeviceId,
  isLocalTerminalAvailable,
  localPathExists,
  openLocalWorkspace,
  startLocalTerminal,
} from '@/lib/local-terminal'
import { configuredWorkspacePath, executionDeviceId } from '@/lib/project-workspace'
import type { ProjectWithTasks, RuntimeWorkListResponse } from '@/types/api'
import type { RuntimeSubagentStatus, WorkbenchMessage } from '@/types/workbench'
import '@/i18n'
import {
  TITLEBAR_ACTIONS_PORTAL_ID,
  TITLEBAR_CENTER_PORTAL_ID,
  TITLEBAR_RIGHT_PANEL_PORTAL_ID,
} from '@/components/topnav/TitlebarActionsPortal'
import { requestDesktopSidebarToggle } from './useDesktopSidebarCollapsed'
import { DesktopWorkbenchLayout as ActualDesktopWorkbenchLayout } from './DesktopWorkbenchLayout'
import { WorkspaceFilePreview } from './workspace-panels/WorkspaceFilePreview'

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
    isWaitingForAssistantIndicator: isSubmitting || isAwaitingAssistant,
    canSendQueuedMessage: !isBusy,
  }
}

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn(),
}))

const tauriMenuMocks = vi.hoisted(() => ({
  getCurrentWindow: vi.fn(),
  menuNew: vi.fn(),
  menuPopup: vi.fn(),
}))

const authMocks = vi.hoisted(() => ({
  logout: vi.fn(),
}))

const openExternalUrlMock = vi.mocked(openExternalUrl)

function createRect({
  left,
  top,
  width,
  height,
}: {
  left: number
  top: number
  width: number
  height: number
}): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect
}

function mockDesktopWorkbenchMainWidth(width: number) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (
      this.tagName === 'MAIN' &&
      this.querySelector('[data-testid="desktop-workbench-content"]')
    ) {
      return createRect({ left: 0, top: 0, width, height: 720 })
    }
    return createRect({ left: 0, top: 0, width: 0, height: 0 })
  })
}

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)

function getWorkspaceCodeViewText() {
  return Array.from(
    document.querySelectorAll('[data-testid="workspace-file-preview-code-view"] diffs-container')
  )
    .map(container => container.shadowRoot?.textContent ?? '')
    .join('\n')
}

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: () => ({ appBasePath: '', apiBaseUrl: '/api' }),
  stripAppBasePath: (path: string) => path,
}))

vi.mock('@/api/http', () => ({
  createHttpClient: vi.fn(() => ({})),
}))

vi.mock('@/api/devices', () => ({
  createDeviceApi: vi.fn(),
}))

vi.mock('@/api/projects', () => ({
  createProjectApi: vi.fn(),
}))

vi.mock('@/api/local/codexUsage', () => ({
  emptyCodexUsageDisplay: () => ({
    status: 'none',
    fiveHour: { label: '5h', title: '5小时额度', value: '无', percent: null, resetsAt: null },
    sevenDay: { label: '7d', title: '7天额度', value: '无', percent: null, resetsAt: null },
    trayTitle: '5h --\n7d --',
    tooltip: '5小时额度 无\n7天额度 无',
  }),
  getLocalCodexUsageDisplay: vi.fn(),
}))

vi.mock('@/features/auth/useAuth', async importOriginal => ({
  ...(await importOriginal<typeof import('@/features/auth/useAuth')>()),
  useAuth: () => ({
    logout: authMocks.logout,
  }),
}))

vi.mock('@/lib/local-terminal', () => ({
  closeLocalTerminal: vi.fn(),
  getLocalExecutorDeviceId: vi.fn(),
  isLocalTerminalAvailable: vi.fn(),
  localPathExists: vi.fn(),
  openLocalWorkspace: vi.fn(),
  startLocalTerminal: vi.fn(),
}))

vi.mock('@pierre/diffs/react', async () => {
  const actual = await vi.importActual<typeof import('@pierre/diffs/react')>('@pierre/diffs/react')

  return {
    ...actual,
    PatchDiff: ({ patch }: { patch: string }) => <pre data-testid="pierre-patch-diff">{patch}</pre>,
  }
})

vi.mock('@pierre/trees/react', async () => {
  const React = await vi.importActual<typeof import('react')>('react')

  interface MockTreeModel {
    paths: string[]
    search: string | null
    selectedPaths: string[]
    onSelectionChange?: (paths: string[]) => void
    getItem: (path: string) => {
      expand: () => void
      select: () => void
    }
    scrollToPath: () => void
    selectPath: (path: string) => void
    setSearch: (query: string | null) => void
  }

  function selectModelPath(model: MockTreeModel, path: string) {
    if (model.selectedPaths[0] === path) return

    model.selectedPaths = [path]
    model.onSelectionChange?.([path])
  }

  return {
    FileTree: ({ model, ...props }: { model: MockTreeModel; [key: string]: unknown }) => {
      const visiblePaths = model.search
        ? model.paths.filter(path => path.toLowerCase().includes(model.search!.toLowerCase()))
        : model.paths

      return (
        <div {...props}>
          {visiblePaths.map(path => {
            const isDirectory = path.endsWith('/')
            const label = path.replace(/\/+$/, '').split('/').pop() || path
            const depth = path.replace(/\/+$/, '').split('/').length - 1
            const selected = model.selectedPaths.includes(path)
            const testId = isDirectory ? 'workspace-directory-row' : 'workspace-file-row'

            return (
              <button
                key={path}
                type="button"
                data-testid={testId}
                data-depth={depth.toString()}
                aria-expanded={isDirectory ? 'true' : undefined}
                className={selected ? 'ring-1 ring-primary' : undefined}
                onClick={() => model.selectPath(path)}
              >
                {Array.from({ length: depth }, (_, index) => (
                  <span key={index} data-testid="workspace-tree-indent-guide" />
                ))}
                {label}
              </button>
            )
          })}
        </div>
      )
    },
    useFileTree: ({
      initialSelectedPaths,
      onSelectionChange,
      paths,
    }: {
      initialSelectedPaths?: string[]
      onSelectionChange?: (paths: string[]) => void
      paths: string[]
    }) => {
      const modelRef = React.useRef<MockTreeModel | null>(null)

      if (!modelRef.current) {
        modelRef.current = {
          paths,
          search: null,
          selectedPaths: initialSelectedPaths ?? [],
          onSelectionChange,
          getItem: (path: string) => ({
            expand: vi.fn(),
            select: () => selectModelPath(modelRef.current!, path),
          }),
          scrollToPath: vi.fn(),
          selectPath: (path: string) => selectModelPath(modelRef.current!, path),
          setSearch(query: string | null) {
            this.search = query
          },
        }
      }

      modelRef.current.paths = paths
      modelRef.current.onSelectionChange = onSelectionChange
      modelRef.current.selectedPaths = initialSelectedPaths ?? modelRef.current.selectedPaths

      return { model: modelRef.current }
    },
  }
})

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalPosition: class LogicalPosition {
    x: number
    y: number

    constructor(x: number, y: number) {
      this.x = x
      this.y = y
    }
  },
}))

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: {
    new: tauriMenuMocks.menuNew,
  },
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: tauriMenuMocks.getCurrentWindow,
}))

vi.mock('./workspace-panels/RemoteTerminal', () => ({
  RemoteTerminal: ({
    active,
    sessionId,
    testIdsEnabled = true,
  }: {
    active: boolean
    sessionId: string
    testIdsEnabled?: boolean
  }) => (
    <div
      data-testid={testIdsEnabled ? 'remote-terminal' : undefined}
      data-session-id={sessionId}
      className="h-full w-full"
      hidden={!active}
    />
  ),
}))

vi.mock('./workspace-panels/EmbeddedLocalTerminal', () => ({
  EmbeddedLocalTerminal: ({
    active,
    sessionId,
    testIdsEnabled = true,
  }: {
    active: boolean
    sessionId: string
    testIdsEnabled?: boolean
  }) => (
    <div
      data-testid={testIdsEnabled ? 'embedded-local-terminal' : undefined}
      data-session-id={sessionId}
      hidden={!active}
    />
  ),
}))

const createDeviceApiMock = vi.mocked(createDeviceApi)
const createProjectApiMock = vi.mocked(createProjectApi)
const getLocalCodexUsageDisplayMock = vi.mocked(getLocalCodexUsageDisplay)
const closeLocalTerminalMock = vi.mocked(closeLocalTerminal)
const getLocalExecutorDeviceIdMock = vi.mocked(getLocalExecutorDeviceId)
const isLocalTerminalAvailableMock = vi.mocked(isLocalTerminalAvailable)
const localPathExistsMock = vi.mocked(localPathExists)
const openLocalWorkspaceMock = vi.mocked(openLocalWorkspace)
const startLocalTerminalMock = vi.mocked(startLocalTerminal)
const startTerminalSessionMock = vi.fn()
const startCodeServerSessionMock = vi.fn()

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

describe('DesktopWorkbenchLayout', () => {
  function createDeferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    return { promise, resolve, reject }
  }

  function getDesktopWorkbenchMainElement() {
    const main = screen.getByTestId('desktop-workbench-content').closest('main')
    if (!main) {
      throw new Error('Desktop workbench main element was not rendered')
    }
    return main
  }

  function createMockDeviceApi(overrides: Record<string, unknown> = {}) {
    return {
      getHomeDirectory: vi.fn().mockResolvedValue('/home/ubuntu'),
      getProjectWorkspaceRoot: vi.fn().mockResolvedValue('/workspace/projects'),
      listDirectories: vi.fn().mockResolvedValue([]),
      listWorkspaceEntries: vi.fn().mockResolvedValue({
        path: '/workspace/project',
        entries: [],
      }),
      readWorkspaceTextFile: vi.fn(),
      executeCommand: vi.fn(),
      getAllDevices: vi.fn().mockResolvedValue([
        {
          id: 1,
          device_id: '24a59054-4638-4744-983d-372706c30fcd',
          name: 'yunpeng7-executor-372706c30fcd',
          status: 'online',
          is_default: false,
          device_type: 'cloud',
          bind_shell: 'claudecode',
          executor_version: '1.712',
          cpu_usage: 42,
          memory_usage: 68,
          disk_usage: 57,
        },
      ]),
      startTerminal: vi.fn(),
      startCodeServer: vi.fn(),
      createCloudDevice: vi.fn(),
      renameDevice: vi.fn(),
      restartCloudDevice: vi.fn(),
      deleteCloudDevice: vi.fn(),
      getMetrics: vi.fn().mockResolvedValue({
        cpu_usage: 42,
        memory_usage: 68,
        disk_usage: 57,
      }),
      getMetricsHistory: vi.fn().mockResolvedValue({
        cpu: [],
        memory: [],
        disk: [],
      }),
      getVncConfig: vi.fn(),
      ...overrides,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1024,
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 720,
    })
    tauriMenuMocks.getCurrentWindow.mockReturnValue({
      label: 'main',
      onDragDropEvent: vi.fn().mockResolvedValue(vi.fn()),
    })
    tauriMenuMocks.menuNew.mockResolvedValue({ popup: tauriMenuMocks.menuPopup })
    tauriMenuMocks.menuPopup.mockResolvedValue(undefined)
    document.getElementById(TITLEBAR_ACTIONS_PORTAL_ID)?.remove()
    document.getElementById(TITLEBAR_CENTER_PORTAL_ID)?.remove()
    document.getElementById(TITLEBAR_RIGHT_PANEL_PORTAL_ID)?.remove()
    screen.queryByTestId('titlebar-center')?.remove()
    screen.queryByTestId('titlebar-right-workspace-zone')?.remove()
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    localStorage.clear()
    window.history.pushState({}, '', '/')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
    Element.prototype.scrollIntoView = vi.fn()
    isLocalTerminalAvailableMock.mockReturnValue(false)
    getLocalExecutorDeviceIdMock.mockResolvedValue(null)
    localPathExistsMock.mockResolvedValue(false)
    openLocalWorkspaceMock.mockResolvedValue(undefined)
    openExternalUrlMock.mockResolvedValue(true)
    startLocalTerminalMock.mockResolvedValue('local-terminal-1')
    closeLocalTerminalMock.mockResolvedValue(undefined)
    getLocalCodexUsageDisplayMock.mockResolvedValue({
      status: 'available',
      fiveHour: { label: '5h', title: '5小时额度', value: '87%', percent: 87, resetsAt: null },
      sevenDay: { label: '7d', title: '7天额度', value: '42%', percent: 42, resetsAt: null },
      trayTitle: '5h 87%\n7d 42%',
      tooltip: '5小时额度 87%\n7天额度 42%',
    })
    createDeviceApiMock.mockReturnValue(createMockDeviceApi() as never)
    startCodeServerSessionMock.mockResolvedValue({
      url: 'http://localhost/ide',
      path: '/workspace/projects/github_wegent',
    })
    startTerminalSessionMock.mockResolvedValue({
      session_id: 'terminal-1',
      url: '',
      transport: 'socketio',
      device_id: 'workspace-cloud-device',
      path: '/workspace/project',
    })
    createProjectApiMock.mockReturnValue({
      startTerminalSession: startTerminalSessionMock,
      startCodeServerSession: startCodeServerSessionMock,
    } as unknown as ReturnType<typeof createProjectApi>)
  })

  const baseProps = {
    state: {
      user: null,
      defaultTeam: null,
      projects: [{ id: 1, name: 'github_wegent', tasks: [] }],
      devices: [],
      runtimeWork: null,
      currentProject: null,
      currentRuntimeTask: null,
      standaloneDeviceId: null,
      standaloneWorkspacePath: null,
      input: '',
      isBootstrapping: false,
      isSending: false,
      error: null,
    },
    messages: [],
    workspaceFileApi: {
      listWorkspaceEntries: vi.fn().mockResolvedValue({
        path: '/workspace/project',
        entries: [],
      }),
      readWorkspaceTextFile: vi.fn(),
    },
    onNewChat: vi.fn(),
    onStartStandaloneChat: vi.fn(),
    onOpenPlugins: vi.fn(),
    projectChat: {
      models: [],
      skills: [],
      selectedModel: null,
      selectedModelOptions: {},
      selectedSkills: [],
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
      isOptionsLocked: false,
      isAttachmentReadyToSend: true,
      setSelectedModel: vi.fn(),
      setSelectedModelOption: vi.fn(),
      setSelectedSkills: vi.fn(),
      toggleSkill: vi.fn(),
      handleFileSelect: vi.fn(),
      addExistingAttachment: vi.fn(),
      removeAttachment: vi.fn(),
      resetAttachments: vi.fn(),
      listLocalSkills: vi.fn().mockResolvedValue([]),
    },
    projectWork: {
      projects: [{ id: 1, name: 'github_wegent', tasks: [] }],
      devices: [],
      currentProjectId: undefined,
      currentStandaloneDeviceId: null,
      executionMode: 'current_workspace',
      executionModeLocked: false,
      onSelectProject: vi.fn(),
      onSelectStandaloneDevice: vi.fn(),
      onExecutionModeChange: vi.fn(),
    },
    onSelectProject: vi.fn(),
    onStartNewProjectChat: vi.fn(),
    onOpenStandaloneWorkspace: vi.fn(),
    onCreateProject: vi.fn(),
    onCreateGitWorkspaceProject: vi.fn(),
    onUpdateProjectName: vi.fn(),
    onRemoveProject: vi.fn(),
    onGetDeviceHomeDirectory: vi.fn().mockResolvedValue('/home/ubuntu'),
    onGetProjectWorkspaceRoot: vi.fn().mockResolvedValue('/workspace/projects'),
    onListDeviceDirectories: vi.fn().mockResolvedValue([]),
    onCreateDeviceDirectory: vi.fn(),
    onListGitRepositories: vi.fn().mockResolvedValue([]),
    onListGitBranches: vi.fn().mockResolvedValue([]),
    onLoadEnvironmentInfo: vi.fn().mockResolvedValue({
      additions: '+173',
      deletions: '-13366',
      executionTarget: 'local' as const,
      deviceId: 'e13e1a10-5377-4a87-a3b3-634a098d0bb4',
      branchName: 'human/narwhal-20260528-073440',
      createPullRequestUrl:
        'https://github.com/wecode-ai/Wegent/compare/human%2Fnarwhal-20260528-073440?expand=1',
    }),
    onCommitEnvironmentChanges: vi.fn().mockResolvedValue(undefined),
    onListEnvironmentBranches: vi
      .fn()
      .mockResolvedValue([
        'main',
        'human/chipmunk-20260603-053420',
        'human/narwhal-20260528-073440',
      ]),
    onCheckoutEnvironmentBranch: vi.fn().mockResolvedValue(undefined),
    onCreateEnvironmentBranch: vi.fn().mockResolvedValue(undefined),
    onLoadEnvironmentDiff: vi
      .fn()
      .mockResolvedValue(
        'diff --git a/src/env.ts b/src/env.ts\n--- a/src/env.ts\n+++ b/src/env.ts\n@@ -1 +1 @@\n-old\n+new\n'
      ),
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onRequestUserInputSubmit: vi.fn().mockResolvedValue(true),
    onLogout: vi.fn(),
  }

  function createPendingRequestUserInputMessage(): WorkbenchMessage {
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
            ],
          },
        },
      ],
    }
  }

  type LegacyDesktopWorkbenchLayoutProps = {
    state?: Record<string, unknown>
    messages?: WorkbenchMessage[]
    queuedMessages?: unknown[]
    guidanceMessages?: unknown[]
    codeCommentContexts?: unknown[]
    subagentStatuses?: RuntimeSubagentStatus[]
    workspaceFileApi?: WorkbenchContextValue['workspaceFileApi']
    currentRuntimeTaskRunning?: boolean
    isAwaitingAssistantStart?: boolean
    isRuntimeTranscriptLoading?: boolean
    runtimeTranscriptHasMoreBefore?: boolean
    isRuntimeTranscriptLoadingMore?: boolean
    projectChat?: Partial<ProjectChatControls>
    projectWork?: Record<string, unknown>
    onSelectProject?: (projectId: number | null) => void
    onStartStandaloneChat?: () => void
    onStartNewProjectChat?: (projectId: number) => void
    onOpenStandaloneWorkspace?: (...args: unknown[]) => Promise<void> | void
    onOpenRuntimeTask?: (...args: unknown[]) => Promise<void> | void
    onSearchRuntimeWork?: (...args: unknown[]) => Promise<unknown>
    onListImPrivateSessions?: () => Promise<unknown>
    onBindRuntimeTaskToImSessions?: (...args: unknown[]) => Promise<unknown>
    onGetImNotificationSettings?: () => Promise<unknown>
    onUpdateGlobalImNotification?: (...args: unknown[]) => Promise<unknown>
    onSubscribeRuntimeTaskNotifications?: (...args: unknown[]) => Promise<unknown>
    onUnsubscribeRuntimeTaskNotifications?: (...args: unknown[]) => Promise<unknown>
    onRefreshDevices?: () => Promise<void>
    onUpgradeDevice?: (...args: unknown[]) => Promise<void>
    onCreateProject?: (...args: unknown[]) => Promise<unknown>
    onCreateGitWorkspaceProject?: (...args: unknown[]) => Promise<unknown>
    onPrepareDeviceWorkspace?: (...args: unknown[]) => Promise<unknown>
    onDeleteDeviceWorkspace?: (...args: unknown[]) => Promise<void>
    onListGitRepositories?: () => Promise<unknown[]>
    onListGitBranches?: (...args: unknown[]) => Promise<unknown[]>
    onUpdateProjectName?: (...args: unknown[]) => Promise<void> | void
    onRemoveProject?: (...args: unknown[]) => Promise<void> | void
    onGetDeviceHomeDirectory?: (...args: unknown[]) => Promise<string>
    onGetProjectWorkspaceRoot?: (...args: unknown[]) => Promise<string>
    onListDeviceDirectories?: (...args: unknown[]) => Promise<string[]>
    onCreateDeviceDirectory?: (...args: unknown[]) => Promise<void>
    onLoadEnvironmentInfo?: (...args: unknown[]) => Promise<unknown>
    onLoadEnvironmentDiff?: (...args: unknown[]) => Promise<string>
    onCommitEnvironmentChanges?: (...args: unknown[]) => Promise<void>
    onListEnvironmentBranches?: (...args: unknown[]) => Promise<string[]>
    onCheckoutEnvironmentBranch?: (...args: unknown[]) => Promise<void>
    onCreateEnvironmentBranch?: (...args: unknown[]) => Promise<void>
    onInputChange?: (input: string) => void
    onSend?: () => void | Promise<void>
    onRequestUserInputSubmit?: (...args: unknown[]) => Promise<boolean> | void
    onLogout?: () => void
  }

  function DesktopWorkbenchLayout(props: LegacyDesktopWorkbenchLayoutProps) {
    const { authValue, workbenchValue, paneValue, paneSession } = createWorkbenchMocks(props)
    paneSessionMockRef.current = paneSession

    return (
      <AuthContext.Provider value={authValue}>
        <WorkbenchContext.Provider value={workbenchValue}>
          <WorkbenchPaneContext.Provider value={paneValue}>
            <ActualDesktopWorkbenchLayout />
          </WorkbenchPaneContext.Provider>
        </WorkbenchContext.Provider>
      </AuthContext.Provider>
    )
  }

  const derivedRuntimeWorkCache = new Map<string, RuntimeWorkListResponse>()

  function createRuntimeWorkForProject(
    project: ProjectWithTasks | null | undefined,
    selectedDeviceWorkspaceId?: unknown
  ): RuntimeWorkListResponse | null {
    if (!project) return null

    const deviceId = executionDeviceId(project)
    const workspacePath = configuredWorkspacePath(project)
    if (!deviceId || !workspacePath?.startsWith('/')) return null

    const workspaceId =
      typeof selectedDeviceWorkspaceId === 'number' ? selectedDeviceWorkspaceId : project.id
    const cacheKey = JSON.stringify([
      project.id,
      project.name,
      deviceId,
      workspacePath,
      workspaceId,
    ])
    const cached = derivedRuntimeWorkCache.get(cacheKey)
    if (cached) return cached

    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: `project:${project.id}`, id: project.id, name: project.name },
          deviceWorkspaces: [
            {
              id: workspaceId,
              projectId: project.id,
              deviceId,
              available: true,
              mapped: true,
              workspacePath,
              tasks: [],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 0,
    }
    derivedRuntimeWorkCache.set(cacheKey, runtimeWork)
    return runtimeWork
  }

  function createWorkbenchMocks(props: LegacyDesktopWorkbenchLayoutProps) {
    const projectWork = props.projectWork === baseProps.projectWork ? {} : (props.projectWork ?? {})
    const rawStateProjects = (projectWork.projects ??
      props.state?.projects ??
      baseProps.state.projects) as WorkbenchContextValue['state']['projects'] | undefined
    const activeProject =
      props.state?.currentProject ??
      projectWork.currentProject ??
      (projectWork.currentProjectId != null && rawStateProjects
        ? rawStateProjects.find(project => project.id === projectWork.currentProjectId)
        : null) ??
      null
    const stateProjects =
      activeProject && rawStateProjects
        ? rawStateProjects.some(project => project.id === activeProject.id)
          ? rawStateProjects.map(project =>
              project.id === activeProject.id ? activeProject : project
            )
          : [...rawStateProjects, activeProject]
        : rawStateProjects
    const selectedDeviceWorkspaceId =
      props.state?.selectedDeviceWorkspaceId ?? projectWork.selectedDeviceWorkspaceId ?? null
    const explicitRuntimeWork = projectWork.runtimeWork ?? props.state?.runtimeWork
    const shouldDeriveRuntimeWork =
      props.projectWork == null || props.projectWork === baseProps.projectWork
    const runtimeWork =
      explicitRuntimeWork ??
      (shouldDeriveRuntimeWork
        ? createRuntimeWorkForProject(
            activeProject as ProjectWithTasks | null,
            selectedDeviceWorkspaceId
          )
        : null) ??
      baseProps.state.runtimeWork
    const state = {
      ...baseProps.state,
      selectedDeviceWorkspaceId: null,
      pendingProjectWorkspaceProjectId: null,
      standaloneWorkspacePath: null,
      ...props.state,
      projects: stateProjects,
      devices: projectWork.devices ?? props.state?.devices ?? baseProps.state.devices,
      runtimeWork,
      currentProject: activeProject,
      standaloneDeviceId:
        props.state?.standaloneDeviceId ?? projectWork.currentStandaloneDeviceId ?? null,
      selectedDeviceWorkspaceId,
      pendingProjectWorkspaceProjectId:
        props.state?.pendingProjectWorkspaceProjectId ??
        projectWork.pendingProjectWorkspaceProjectId ??
        null,
    }
    const projectChat = {
      ...baseProps.projectChat,
      isModelSelectionReady: true,
      onBlockedModelSelect: vi.fn(),
      ...props.projectChat,
    }
    const workbenchValue = {
      state,
      isStartupReady: true,
      workspaceFileApi: props.workspaceFileApi ?? baseProps.workspaceFileApi,
      currentRuntimeTaskRunning:
        props.currentRuntimeTaskRunning ?? Boolean(state.currentRuntimeTask),
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
      openStandaloneWorkspace:
        props.onOpenStandaloneWorkspace ?? baseProps.onOpenStandaloneWorkspace,
      startNewChat: baseProps.onNewChat,
      startStandaloneChat: props.onStartStandaloneChat ?? vi.fn(),
      startNewProjectChat: props.onStartNewProjectChat ?? baseProps.onStartNewProjectChat,
      openRuntimeTask: props.onOpenRuntimeTask ?? vi.fn().mockResolvedValue(undefined),
      searchRuntimeWork: props.onSearchRuntimeWork ?? vi.fn().mockResolvedValue({ items: [] }),
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
      getImNotificationSettings:
        props.onGetImNotificationSettings ??
        vi.fn().mockResolvedValue(createDefaultImNotificationSettings()),
      updateGlobalImNotification:
        props.onUpdateGlobalImNotification ??
        vi.fn().mockResolvedValue(createDefaultImNotificationSettings()),
      subscribeRuntimeTaskNotifications:
        props.onSubscribeRuntimeTaskNotifications ??
        vi.fn().mockResolvedValue({ subscribed: true }),
      unsubscribeRuntimeTaskNotifications:
        props.onUnsubscribeRuntimeTaskNotifications ??
        vi.fn().mockResolvedValue({ subscribed: false }),
      rememberExecutionDevice: vi.fn(),
      refreshWorkLists: vi.fn().mockResolvedValue(undefined),
      refreshDevices: props.onRefreshDevices ?? vi.fn().mockResolvedValue(undefined),
      getRemoteDeviceStartupCommand: vi.fn().mockResolvedValue({ command: '' }),
      upgradeDevice: props.onUpgradeDevice ?? vi.fn().mockResolvedValue(undefined),
      createProject:
        props.onCreateProject ?? baseProps.onCreateProject ?? vi.fn().mockResolvedValue({}),
      createGitWorkspaceProject:
        props.onCreateGitWorkspaceProject ??
        baseProps.onCreateGitWorkspaceProject ??
        vi.fn().mockResolvedValue({}),
      prepareDeviceWorkspace:
        props.onPrepareDeviceWorkspace ??
        vi.fn().mockResolvedValue({ deviceWorkspaceId: 1, workspaceId: 1 }),
      deleteDeviceWorkspace: props.onDeleteDeviceWorkspace ?? vi.fn().mockResolvedValue(undefined),
      listGitRepositories: props.onListGitRepositories ?? baseProps.onListGitRepositories,
      listGitBranches: props.onListGitBranches ?? baseProps.onListGitBranches,
      updateProjectName: props.onUpdateProjectName ?? baseProps.onUpdateProjectName,
      removeProject: props.onRemoveProject ?? baseProps.onRemoveProject,
      getDeviceHomeDirectory: props.onGetDeviceHomeDirectory ?? baseProps.onGetDeviceHomeDirectory,
      getProjectWorkspaceRoot:
        props.onGetProjectWorkspaceRoot ?? baseProps.onGetProjectWorkspaceRoot,
      listDeviceDirectories: props.onListDeviceDirectories ?? baseProps.onListDeviceDirectories,
      createDeviceDirectory: props.onCreateDeviceDirectory ?? baseProps.onCreateDeviceDirectory,
      loadEnvironmentInfo: props.onLoadEnvironmentInfo ?? baseProps.onLoadEnvironmentInfo,
      loadEnvironmentDiff: props.onLoadEnvironmentDiff ?? baseProps.onLoadEnvironmentDiff,
      commitEnvironmentChanges:
        props.onCommitEnvironmentChanges ?? baseProps.onCommitEnvironmentChanges,
      listEnvironmentBranches:
        props.onListEnvironmentBranches ?? baseProps.onListEnvironmentBranches,
      checkoutEnvironmentBranch:
        props.onCheckoutEnvironmentBranch ?? baseProps.onCheckoutEnvironmentBranch,
      createEnvironmentBranch:
        props.onCreateEnvironmentBranch ?? baseProps.onCreateEnvironmentBranch,
      sendRuntimePaneMessage: vi.fn().mockResolvedValue(true),
      cancelRuntimePaneTask: vi.fn().mockResolvedValue(true),
      sendCurrentInput: props.onSend ?? baseProps.onSend,
      retryFailedMessage: vi.fn().mockResolvedValue(undefined),
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
      setInput: props.onInputChange ?? baseProps.onInputChange,
      sending: Boolean(state.isSending),
      waitingForAssistant: Boolean(props.isAwaitingAssistantStart),
      status: createPaneStatus({
        messages: props.messages ?? [],
        sending: Boolean(state.isSending),
        waitingForAssistant: Boolean(props.isAwaitingAssistantStart),
        taskRunning: workbenchValue.currentRuntimeTaskRunning,
      }),
      transcriptLoading: Boolean(props.isRuntimeTranscriptLoading),
      transcriptHasMoreBefore: Boolean(props.runtimeTranscriptHasMoreBefore),
      transcriptLoadingMoreBefore: Boolean(props.isRuntimeTranscriptLoadingMore),
      subagentStatuses: props.subagentStatuses ?? [],
      turnNavigation: [],
      loadMoreTranscriptBefore: vi.fn().mockResolvedValue(undefined),
      loadTranscriptTurnNavigationItem: vi.fn().mockResolvedValue(undefined),
      loadTranscriptGap: vi.fn().mockResolvedValue(undefined),
      send: props.onSend ?? baseProps.onSend,
      sendRequestUserInputResponse:
        props.onRequestUserInputSubmit ?? baseProps.onRequestUserInputSubmit,
      ignoreRequestUserInput: vi.fn(),
      answeredRequestUserInputIds: new Set(),
      addCodeComment: vi.fn(),
      clearCodeComments: vi.fn(),
      cancelQueuedMessage: vi.fn(),
      sendQueuedAsGuidance: vi.fn().mockResolvedValue(undefined),
      editQueuedMessage: vi.fn(),
      cancelGuidanceMessage: vi.fn(),
    }
    const authValue = {
      user: (state.user as WorkbenchContextValue['state']['user']) ?? null,
      isLoading: false,
      adminPasswordSetupRequired: false,
      adminUsername: 'admin',
      login: vi.fn().mockResolvedValue(state.user),
      logout: props.onLogout ?? baseProps.onLogout,
      refresh: vi.fn().mockResolvedValue(undefined),
      loginWithOidcToken: vi.fn().mockResolvedValue(undefined),
      setupAdminPassword: vi.fn().mockResolvedValue(state.user),
    }

    return { authValue, workbenchValue, paneValue, paneSession }
  }

  function createCloudWorkspacePanelState() {
    const workspaceDevice = {
      id: 11,
      device_id: 'workspace-cloud-device',
      name: 'Workspace Cloud Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
    const workspaceProject = {
      id: 12,
      name: 'workspace-project',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'cloud' as const,
          deviceId: workspaceDevice.device_id,
        },
        workspace: {
          source: 'git' as const,
          checkoutPath: '/workspace/project',
        },
      },
    }

    return {
      currentProject: workspaceProject,
      projects: [workspaceProject],
      devices: [workspaceDevice],
    }
  }

  function renderWorkspacePanelLayout({ mainWidth }: { mainWidth?: number } = {}) {
    if (mainWidth) {
      mockDesktopWorkbenchMainWidth(mainWidth)
    }

    const workspacePanelState = createCloudWorkspacePanelState()
    return render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )
  }

  function createLocalRuntimeTaskPanelFixture() {
    const runtimeProject = {
      id: 35,
      name: 'Wegent',
      tasks: [],
    }
    const localDevice = {
      id: 43,
      device_id: 'local-device',
      name: 'Mac',
      status: 'online' as const,
      is_default: false,
      device_type: 'local' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
    const taskSuffixes = 'abcdefghijk'.split('')
    const taskAddresses = taskSuffixes.map(suffix => ({
      deviceId: localDevice.device_id,
      workspacePath: `/Users/me/Wegent/.worktrees/${suffix}`,
      taskId: `runtime-${suffix}`,
    }))
    const runtimeWork = {
      projects: [
        {
          project: {
            id: runtimeProject.id,
            key: 'project:wegent',
            name: runtimeProject.name,
          },
          deviceWorkspaces: [
            {
              id: 44,
              deviceId: localDevice.device_id,
              deviceStatus: 'online' as const,
              available: true,
              workspacePath: '/Users/me/Wegent',
              workspaceSource: 'local' as const,
              tasks: taskSuffixes.map(suffix => ({
                taskId: `runtime-${suffix}`,
                workspacePath: `/Users/me/Wegent/.worktrees/${suffix}`,
                title: `Task ${suffix.toUpperCase()}`,
                runtime: 'codex',
              })),
            },
          ],
        },
      ],
      chats: [],
      totalTasks: taskSuffixes.length,
    }
    const [taskA, taskB, taskC] = taskAddresses
    const propsForTask = (
      task: (typeof taskAddresses)[number],
      options: { runtimeWork?: typeof runtimeWork } = {}
    ) => ({
      ...baseProps,
      state: {
        ...baseProps.state,
        currentProject: runtimeProject,
        currentRuntimeTask: task,
        projects: [runtimeProject],
        devices: [localDevice],
        runtimeWork: options.runtimeWork ?? runtimeWork,
      },
      projectWork: {
        ...baseProps.projectWork,
        projects: [runtimeProject],
        devices: [localDevice],
        runtimeWork: options.runtimeWork ?? runtimeWork,
        currentProject: runtimeProject,
        currentProjectId: runtimeProject.id,
        selectedDeviceWorkspaceId: 44,
        executionMode: 'current_workspace' as const,
      },
    })

    return {
      localDevice,
      propsForTask,
      runtimeWork,
      runtimeProject,
      taskA,
      taskB,
      taskC,
      taskAddresses,
    }
  }

  test('submits implementation plan confirmation as a user message response', async () => {
    const onRequestUserInputSubmit = vi.fn().mockResolvedValue(true)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-plan',
          },
        }}
        messages={[createPendingRequestUserInputMessage()]}
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

  test('ignores the implementation plan confirmation through the pane session', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-plan',
          },
        }}
        messages={[createPendingRequestUserInputMessage()]}
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

  test('does not open assistant markdown as a plan in the right workspace panel', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            id: 'assistant-plan',
            role: 'assistant',
            content: [
              '# Wegent 体验计划',
              '',
              '## Summary',
              '- 优先修复流式展示。',
              '',
              '## Test Plan',
              '- 运行相关前端测试。',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-06-30T00:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('assistant-plan-expand-button')).not.toBeInTheDocument()
    expect(screen.getByText('Wegent 体验计划')).toBeInTheDocument()
  })

  test('opens explicit assistant plan blocks in the right workspace panel', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            id: 'assistant-plan-block',
            role: 'assistant',
            content: '',
            status: 'done',
            createdAt: '2026-06-30T00:00:01.000Z',
            blocks: [
              {
                id: 'plan-1',
                subtaskId: 1,
                type: 'plan',
                content: [
                  '# Wegent 体验计划',
                  '',
                  '## Summary',
                  '- 优先修复流式展示。',
                  '',
                  '## Test Plan',
                  '- 运行相关前端测试。',
                ].join('\n'),
                status: 'done',
                createdAt: Date.parse('2026-06-30T00:00:01.000Z'),
              },
            ],
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-plan-card')).toHaveTextContent('Wegent 体验计划')

    await userEvent.click(screen.getByTestId('assistant-plan-expand-button'))

    expect(screen.getByTestId('workspace-plan-panel')).toHaveTextContent('Wegent 体验计划')
    expect(screen.getByTestId('workspace-plan-panel')).toHaveTextContent('运行相关前端测试')
  })

  test('renders project-specific empty prompt after selecting a project', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: { id: 1, name: 'gitlab-wegent', tasks: [] },
        }}
      />
    )

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      '我们应该在 gitlab-wegent 中构建什么？'
    )
  })

  test('keeps the empty composer at the intended desktop proportion', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('desktop-empty-composer-frame')).toHaveClass(
      'w-[min(46rem,calc(100%_-_2rem))]',
      'min-w-0',
      'max-w-[calc(100%_-_2rem)]',
      '-translate-y-12'
    )
  })

  test('renders the conversation composer as a floating overlay', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
      />
    )

    const desktopContent = screen.getByTestId('desktop-workbench-content')
    expect(desktopContent).toHaveClass('pt-11')
    expect(desktopContent.style.getPropertyValue('--desktop-floating-composer-clearance')).toBe(
      '136px'
    )
    expect(screen.getByTestId('desktop-chat-scroll')).toHaveClass(
      'h-full',
      'overflow-y-auto',
      'scrollbar-soft',
      'pb-[var(--desktop-floating-composer-clearance)]'
    )
    expect(screen.getByTestId('desktop-chat-scroll')).not.toHaveClass(
      'overflow-x-hidden',
      'overflow-x-clip'
    )
    expect(screen.getByTestId('desktop-chat-scroll-content')).not.toHaveClass('justify-end')
    expect(screen.getByTestId('desktop-chat-scroll-content').firstElementChild).toHaveClass(
      'w-[min(46rem,calc(100%_-_6rem))]',
      'min-w-0',
      'max-w-[calc(100%_-_6rem)]',
      'px-0'
    )
    expect(screen.getByTestId('desktop-floating-composer-backdrop')).toHaveClass(
      'pointer-events-none',
      'absolute',
      'left-0',
      'right-8',
      'bottom-0',
      'z-10',
      'from-background'
    )
    expect(screen.getByTestId('desktop-floating-composer-backdrop')).not.toHaveClass('inset-x-0')
    expect(screen.getByTestId('desktop-floating-composer-layer')).toHaveClass(
      'pointer-events-none',
      'absolute',
      'bottom-2',
      'left-1/2',
      'z-chrome',
      '-translate-x-1/2'
    )
    expect(screen.getByTestId('desktop-floating-composer-card')).toHaveClass('pointer-events-auto')
    expect(screen.queryByTestId('project-work-button')).not.toBeInTheDocument()
  })

  test('renders subagent status below the top bar without shifting messages', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
        subagentStatuses={[
          {
            id: 'subagent-1',
            agentId: 'thread:019f17ae-8295-7072-84e0-94ca0ffa96e5',
            agentPath: 'thread:019f17ae-8295-7072-84e0-94ca0ffa96e5',
            agentName: 'worker',
            status: 'running',
            updatedAtMs: 12345,
          },
        ]}
      />
    )

    expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
    const statusRow = screen.getByTestId('workbench-subagent-status-row')
    expect(statusRow).toContainElement(screen.getByTestId('subagent-status-toggle-button'))
    expect(statusRow).toHaveClass('right-3', 'top-14')
    expect(screen.getByTestId('desktop-workbench-content')).toHaveClass('pt-11')
  })

  test('treats a selected runtime task with an empty transcript as a conversation', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          runtimeWork: {
            projects: [],
            chats: [
              {
                deviceId: 'device-1',
                deviceName: 'Runtime Device',
                workspacePath: '/workspace/project-alpha',
                workspaceKind: 'workspace',
                tasks: [
                  {
                    taskId: 'runtime-empty',
                    workspacePath: '/workspace/project-alpha',
                    title: 'Fix pane title',
                    runtime: 'codex',
                    createdAt: '2026-06-20T00:00:00.000Z',
                    updatedAt: '2026-06-20T00:00:00.000Z',
                    running: true,
                  },
                ],
              },
            ],
            totalTasks: 1,
          },
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-empty',
          },
        }}
        messages={[]}
      />
    )

    expect(screen.getByTestId('desktop-floating-composer-layer')).toBeInTheDocument()
    expect(screen.queryByTestId('desktop-empty-composer-frame')).not.toBeInTheDocument()
    const paneTitle = screen.getByTestId('workbench-pane-task-title')
    expect(paneTitle).toHaveTextContent('Fix pane title')
    expect(paneTitle).toHaveClass('truncate', 'text-[13px]', 'text-text-primary')
    expect(screen.getByTestId('workbench-topbar')).toHaveClass(
      'h-11',
      'border-b',
      'border-border/50',
      'bg-background/95'
    )
  })

  test('opens continue-in-im dialog from the active runtime task topbar button', async () => {
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

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
        onListImPrivateSessions={onListImPrivateSessions}
      />
    )

    await userEvent.click(screen.getByTestId('continue-in-im-button'))

    expect(onListImPrivateSessions).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByTestId('continue-im-session-session-1')).toHaveTextContent('Alice')
  })

  test('keeps continue-in-im action with workspace panel actions on web', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
      />
    )

    const floatingActions = screen.getByTestId('workspace-panel-floating-actions')
    expect(floatingActions).toContainElement(screen.getByTestId('continue-in-im-button'))
    expect(floatingActions).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
    expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
  })

  test('keeps continue-in-im action with titlebar actions in Tauri', () => {
    const previousTauriInternals = (window as typeof window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    try {
      render(
        <DesktopWorkbenchLayout
          {...baseProps}
          state={{
            ...baseProps.state,
            currentRuntimeTask: {
              deviceId: 'device-1',
              workspacePath: '/workspace/project-alpha',
              taskId: 'runtime-1',
            },
          }}
          messages={[
            {
              id: 'message-1',
              role: 'assistant',
              content: 'Ready',
              status: 'done',
              createdAt: '2026-06-20T00:00:00.000Z',
            },
          ]}
        />
      )

      const titlebarMainActions = screen.getByTestId('titlebar-main-actions')
      const titlebarActions = screen.getByTestId('titlebar-actions')
      expect(titlebarMainActions).toContainElement(screen.getByTestId('continue-in-im-button'))
      expect(titlebarMainActions).toContainElement(screen.getByTestId('fork-runtime-task-button'))
      expect(titlebarActions).not.toContainElement(screen.getByTestId('continue-in-im-button'))
      expect(titlebarActions).not.toContainElement(screen.getByTestId('fork-runtime-task-button'))
      expect(titlebarActions).toContainElement(
        screen.getByTestId('toggle-right-workspace-panel-button')
      )
      expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
    } finally {
      if (previousTauriInternals === undefined) {
        delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
      } else {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
          configurable: true,
          value: previousTauriInternals,
        })
      }
    }
  })

  test('hides continue-in-im action without a runtime task', () => {
    const onListImPrivateSessions = vi.fn().mockResolvedValue({ total: 0, items: [] })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={baseProps.state}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
        onListImPrivateSessions={onListImPrivateSessions}
      />
    )

    expect(screen.queryByTestId('continue-in-im-button')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onListImPrivateSessions).not.toHaveBeenCalled()
  })

  test('ignores stale private session responses when reopening the dialog', async () => {
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

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
        onListImPrivateSessions={onListImPrivateSessions}
      />
    )

    await userEvent.click(screen.getByTestId('continue-in-im-button'))
    await userEvent.click(screen.getByTestId('continue-im-cancel-button'))
    await userEvent.click(screen.getByTestId('continue-in-im-button'))

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

  test('shows a failure notice when bind handler is missing', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
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

    await userEvent.click(screen.getByTestId('continue-in-im-button'))
    expect(await screen.findByTestId('continue-im-session-session-1')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await userEvent.click(screen.getByTestId('continue-im-submit-button'))

    expect(await screen.findByTestId('transient-notice')).toHaveTextContent('继续到私聊失败')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  test('positions the scroll-to-bottom button above the floating composer', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Long reply',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
      />
    )

    const scroller = screen.getByTestId('desktop-chat-scroll')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 600,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })

    fireEvent.scroll(scroller)

    expect(screen.getByTestId('scroll-to-bottom-button')).toHaveClass(
      'bottom-[var(--desktop-floating-composer-clearance)]',
      'z-popover'
    )
  })

  test('reserves extra bottom space when queued messages are shown above the composer', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
        queuedMessages={[
          {
            id: 'queued-1',
            content: '你叫什么',
            status: 'failed',
            error: '发送失败',
            createdAt: '2026-05-29T00:01:00.000Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('desktop-chat-scroll')).toHaveClass(
      'pb-[var(--desktop-floating-composer-clearance)]'
    )
  })

  test('restores and stores sidebar width in localStorage', () => {
    localStorage.setItem('wework.desktop.sidebar.width', '340')

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(document.querySelector('aside')).toHaveStyle({ width: '340px' })

    fireEvent.pointerDown(screen.getByTestId('sidebar-resize-handle'))
    fireEvent.pointerMove(document, { clientX: 360 })
    fireEvent.pointerUp(document)

    expect(document.querySelector('aside')).toHaveStyle({ width: '360px' })
    expect(localStorage.getItem('wework.desktop.sidebar.width')).toBe('360')
  })

  test('clamps sidebar resizing to the maximum width', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    fireEvent.pointerDown(screen.getByTestId('sidebar-resize-handle'))
    fireEvent.pointerMove(document, { clientX: 900 })
    fireEvent.pointerUp(document)

    expect(document.querySelector('aside')).toHaveStyle({ width: '480px' })
    expect(localStorage.getItem('wework.desktop.sidebar.width')).toBe('480')
  })

  test('collapses the sidebar when dragging below the close threshold', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    const sidebar = screen.getByTestId('desktop-sidebar')
    expect(sidebar).toHaveStyle({ width: '240px' })

    fireEvent.pointerDown(screen.getByTestId('sidebar-resize-handle'))
    fireEvent.pointerMove(document, { clientX: 150 })

    expect(sidebar).toHaveStyle({ width: '0px' })
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('desktop-sidebar-hover-edge')).toBeInTheDocument()
    expect(getDesktopWorkbenchMainElement()).not.toHaveClass('ml-1.5')
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  test('uses the selected sidebar width as the default', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(document.querySelector('aside')).toHaveStyle({ width: '240px' })
  })

  test('clamps older narrow stored sidebar widths to the new minimum', () => {
    localStorage.setItem('wework.desktop.sidebar.width', '240')

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(document.querySelector('aside')).toHaveStyle({ width: '240px' })
  })

  test('auto-collapses the sidebar in compact desktop windows and restores it when wide', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 920,
    })

    render(<DesktopWorkbenchLayout {...baseProps} />)

    const sidebar = screen.getByTestId('desktop-sidebar')
    await waitFor(() => expect(sidebar).toHaveStyle({ width: '0px' }))
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('desktop-sidebar-hover-edge')).toBeInTheDocument()

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1200,
    })
    fireEvent.resize(window)

    await waitFor(() => expect(sidebar).toHaveStyle({ width: '240px' }))
    expect(sidebar).toHaveAttribute('aria-hidden', 'false')
  })

  test('expands an auto-collapsed sidebar from the titlebar toggle request', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 920,
    })

    render(<DesktopWorkbenchLayout {...baseProps} />)

    const sidebar = screen.getByTestId('desktop-sidebar')
    await waitFor(() => expect(sidebar).toHaveStyle({ width: '0px' }))
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')

    let handled = false
    act(() => {
      handled = requestDesktopSidebarToggle()
    })

    expect(handled).toBe(true)
    await waitFor(() => expect(sidebar).toHaveStyle({ width: '240px' }))
    expect(sidebar).toHaveAttribute('aria-hidden', 'false')
  })

  test('collapses and expands the sidebar', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.queryByTestId('desktop-sidebar-topbar')).not.toBeInTheDocument()
    expect(getDesktopWorkbenchMainElement()).toHaveClass('mt-1.5')
    expect(getDesktopWorkbenchMainElement()).not.toHaveClass('mb-1.5', 'mr-1.5', 'ml-1.5')
    expect(screen.getByTestId('collapse-sidebar-button')).toHaveClass('h-8', 'w-8', 'rounded-lg')
    expect(screen.getByTestId('sidebar-resize-handle')).toHaveClass('right-[-14px]', 'w-[18px]')
    expect(screen.getByTestId('workbench-topbar-left-actions')).toContainElement(
      screen.getByTestId('desktop-window-controls')
    )
    expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('environment-info-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-bottom-workspace-panel-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )

    const sidebar = screen.getByTestId('desktop-sidebar')
    expect(sidebar).toHaveStyle({ width: '240px' })
    await userEvent.click(screen.getByTestId('collapse-sidebar-button'))

    expect(sidebar).toHaveStyle({ width: '0px' })
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    expect(sidebar).toHaveClass('transition-[width]', 'duration-[300ms]', 'will-change-[width]')
    expect(screen.getByTestId('expand-sidebar-button')).toBeInTheDocument()
    expect(screen.getByTestId('workbench-topbar-left-actions')).toContainElement(
      screen.getByTestId('desktop-window-controls')
    )
    expect(getDesktopWorkbenchMainElement()).toHaveClass('mt-1.5')
    expect(getDesktopWorkbenchMainElement()).not.toHaveClass('mb-1.5', 'mr-1.5', 'ml-1.5')
    expect(getDesktopWorkbenchMainElement()).toHaveClass('transition-[margin]', 'duration-[300ms]')
    expect(getDesktopWorkbenchMainElement()).not.toHaveClass('will-change-[margin]')
    expect(screen.getByTestId('desktop-empty-composer-frame')).toHaveClass(
      'w-[min(46rem,calc(100%_-_2rem))]',
      'max-w-[calc(100%_-_2rem)]'
    )
    expect(document.querySelector('aside')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('expand-sidebar-button'))

    expect(screen.getByText('新对话')).toBeInTheDocument()
    expect(sidebar).toHaveStyle({ width: '240px' })
    expect(sidebar).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByTestId('desktop-empty-composer-frame')).toHaveClass(
      'w-[min(46rem,calc(100%_-_2rem))]',
      'max-w-[calc(100%_-_2rem)]'
    )
  })

  test('slides out a sidebar preview from the left edge without resizing the workspace', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('collapse-sidebar-button'))

    const main = getDesktopWorkbenchMainElement()
    const preview = screen.getByTestId('desktop-sidebar-preview')
    expect(main).not.toHaveClass('ml-1.5')
    expect(screen.getByTestId('desktop-sidebar-hover-edge')).toHaveClass('w-4')
    expect(preview).toHaveClass('pointer-events-none', '-translate-x-full', 'opacity-100')

    fireEvent.pointerEnter(screen.getByTestId('desktop-sidebar-hover-edge'))

    expect(preview).toHaveClass('pointer-events-auto', 'translate-x-0', 'opacity-100')
    expect(screen.getByTestId('desktop-sidebar-preview-panel')).toHaveStyle({ width: '240px' })
    expect(main).not.toHaveClass('ml-1.5')

    fireEvent.pointerEnter(preview)

    expect(preview).toHaveClass('translate-x-0', 'opacity-100')

    fireEvent.pointerLeave(preview)

    expect(preview).toHaveClass('pointer-events-none', '-translate-x-full', 'opacity-100')
    expect(main).not.toHaveClass('ml-1.5')
  })

  test('keeps sidebar controls out of the page chrome in Tauri', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.queryByTestId('desktop-sidebar-topbar')).not.toBeInTheDocument()
    expect(screen.getByTestId('desktop-sidebar')).toContainElement(
      screen.getByTestId('collapse-sidebar-button')
    )
    expect(screen.getByTestId('desktop-sidebar-chrome-controls')).toContainElement(
      screen.getByTestId('collapse-sidebar-button')
    )
    expect(screen.getByTestId('desktop-sidebar-chrome-controls')).toHaveClass('left-[92px]')
    expect(screen.getByTestId('desktop-sidebar-chrome-controls')).toContainElement(
      screen.getByTestId('chrome-tab-wework')
    )
    expect(screen.getByTestId('desktop-sidebar-chrome-controls')).toContainElement(
      screen.getByTestId('chrome-tab-apps')
    )
    expect(screen.getByTestId('chrome-tab-wework')).toHaveClass('h-8', 'w-8', 'bg-black/[0.045]')
    expect(screen.getByTestId('chrome-tab-apps')).toHaveClass('h-8', 'w-8', 'text-text-secondary')
    expect(screen.queryByTestId('workbench-topbar')).not.toBeInTheDocument()
    expect(screen.getByTestId('titlebar-main-actions')).toContainElement(
      screen.getByTestId('environment-info-button')
    )
    expect(screen.getByTestId('titlebar-actions')).toContainElement(
      screen.getByTestId('toggle-bottom-workspace-panel-button')
    )
    expect(screen.getByTestId('titlebar-actions')).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
    expect(screen.getByTestId('desktop-workbench-content')).not.toHaveClass('pt-11')
    expect(getDesktopWorkbenchMainElement()).not.toHaveClass('mt-1.5', 'mb-1.5', 'mr-1.5')
  })

  test('keeps a collapsed Tauri task title clear of titlebar controls', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    localStorage.setItem('wework.desktop.sidebar.collapsed', 'true')

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          runtimeWork: {
            projects: [],
            chats: [
              {
                deviceId: 'device-1',
                deviceName: 'Runtime Device',
                workspacePath: '/workspace/project-alpha',
                workspaceKind: 'workspace',
                tasks: [
                  {
                    taskId: 'runtime-empty',
                    workspacePath: '/workspace/project-alpha',
                    title:
                      'wework的聊天链路现在代码逻辑比较混乱，尤其是状态方面，经常出现消息结束了但是发送按钮还显示运行中',
                    runtime: 'codex',
                    createdAt: '2026-06-20T00:00:00.000Z',
                    updatedAt: '2026-06-20T00:00:00.000Z',
                    running: true,
                  },
                ],
              },
            ],
            totalTasks: 1,
          },
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-empty',
          },
        }}
        messages={[]}
      />
    )

    expect(screen.queryByTestId('workbench-topbar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workbench-topbar-left-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('workbench-main-header')).toContainElement(
      screen.getByTestId('workbench-pane-task-title')
    )
    expect(screen.getByTestId('workbench-main-header')).toHaveClass('h-[38px]', 'border-b')
    expect(screen.getByTestId('workbench-main-header-left-controls')).toHaveClass('pl-[92px]')
    expect(screen.getByTestId('workbench-main-header-left-controls')).toContainElement(
      screen.getByTestId('expand-sidebar-button')
    )
    expect(screen.getByTestId('workbench-pane-task-title')).toHaveClass(
      'relative',
      'h-full',
      'flex-1',
      'pl-4',
      'truncate'
    )
    expect(screen.getByTestId('titlebar-main-actions')).toBeInTheDocument()
    expect(screen.getByTestId('workbench-pane-task-title')).toHaveTextContent(
      'wework的聊天链路现在代码逻辑比较混乱'
    )
    expect(screen.getByTestId('workbench-pane-task-title')).not.toHaveAttribute('title')
    expect(screen.getByTestId('desktop-workbench-content')).not.toHaveClass('pt-11')
    expect(getDesktopWorkbenchMainElement()).toHaveClass('top-0')
    expect(getDesktopWorkbenchMainElement()).not.toHaveClass('rounded-xl')
  })

  test('opens project code-server from the Tauri titlebar', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: '24a59054-4638-4744-983d-372706c30fcd',
              },
            },
            tasks: [],
          },
          devices: [
            {
              id: 1,
              device_id: '24a59054-4638-4744-983d-372706c30fcd',
              name: 'cloud executor',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('open-code-server-titlebar-button'))

    await waitFor(() => expect(startCodeServerSessionMock).toHaveBeenCalledWith(1))
    expect(openExternalUrlMock).toHaveBeenCalledWith('http://localhost/ide')
    expect(screen.getByTestId('titlebar-main-actions')).toContainElement(
      screen.getByTestId('open-code-server-titlebar-button')
    )
    expect(screen.getByTestId('open-code-server-titlebar-button')).toHaveAttribute(
      'title',
      '打开项目 IDE'
    )
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).not.toHaveAttribute('title')
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).not.toHaveAttribute('title')
    const bottomPanelTooltip = screen.getByText('切换底部面板显示').closest('[role="tooltip"]')
    expect(bottomPanelTooltip).toHaveTextContent('⌘')
    expect(bottomPanelTooltip).toHaveTextContent('J')
  })

  test('shows project code-server in the Tauri titlebar before devices hydrate', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: '24a59054-4638-4744-983d-372706c30fcd',
              },
            },
            tasks: [],
          },
          devices: [],
        }}
      />
    )

    expect(screen.getByTestId('titlebar-main-actions')).toContainElement(
      screen.getByTestId('open-code-server-titlebar-button')
    )
  })

  test('opens the local project from the Tauri titlebar with VS Code for local devices', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    isLocalTerminalAvailableMock.mockReturnValue(true)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'local-claude',
              },
              workspace: {
                source: 'local_path',
                localPath: '/Users/me/github_wegent',
              },
            },
            tasks: [],
          },
          devices: [
            {
              id: 1,
              device_id: 'local-claude',
              name: 'local claude',
              status: 'online',
              is_default: false,
              device_type: 'local',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    const button = screen.getByTestId('open-code-server-titlebar-button')
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('title', '使用 VS Code 打开')

    await userEvent.click(button)

    expect(openLocalWorkspaceMock).toHaveBeenCalledWith({
      opener: 'vscode',
      path: '/Users/me/github_wegent',
    })
    expect(startCodeServerSessionMock).not.toHaveBeenCalled()
  })

  test('shows a dialog when project code-server fails to start', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    startCodeServerSessionMock.mockRejectedValueOnce(
      new Error('Local devices do not support code-server sessions')
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: '24a59054-4638-4744-983d-372706c30fcd',
              },
            },
            tasks: [],
          },
          devices: [
            {
              id: 1,
              device_id: '24a59054-4638-4744-983d-372706c30fcd',
              name: 'cloud executor',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('open-code-server-titlebar-button'))

    expect(await screen.findByTestId('code-server-error-dialog')).toHaveTextContent(
      'Local devices do not support code-server sessions'
    )
  })

  test('keeps panel toggles in stable workbench actions on web', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('workbench-topbar')).toHaveClass('z-chrome')
    expect(screen.getByTestId('workspace-panel-floating-actions')).toHaveClass(
      'pointer-events-auto',
      'z-popover'
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('environment-info-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-bottom-workspace-panel-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
    expect(screen.queryByTestId('titlebar-actions')).not.toBeInTheDocument()
  })

  test('opens the settings menu from the sidebar', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('settings-button'))

    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    expect(screen.queryByText('Codex 额度')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-menu-button')).toHaveTextContent('设置')
    expect(screen.getByTestId('settings-menu-button')).toHaveTextContent('⌘,')
    expect(screen.getByText('剩余用量')).toBeInTheDocument()
    expect(screen.getByText('退出登录')).toBeInTheDocument()
  })

  test('opens settings page from the browser path on reload', () => {
    window.history.pushState({}, '', '/settings')

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('wework-settings-page')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '我们该做什么？' })).not.toBeInTheDocument()
  })

  test('closes the settings menu when clicking outside it', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('settings-button'))
    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('heading', { name: '我们该做什么？' }))

    expect(screen.queryByTestId('settings-menu')).not.toBeInTheDocument()
  })

  test('expands remaining usage details from the settings menu', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('settings-button'))
    await userEvent.click(screen.getByTestId('usage-menu-button'))

    await waitFor(() => expect(getLocalCodexUsageDisplayMock).toHaveBeenCalled())

    const usagePanel = await screen.findByTestId('usage-detail-panel')
    expect(within(usagePanel).queryByText('模型额度')).not.toBeInTheDocument()
    expect(usagePanel).toHaveTextContent('5小时额度')
    expect(usagePanel).toHaveTextContent('87%')
    expect(usagePanel).toHaveTextContent('7天额度')
    expect(usagePanel).toHaveTextContent('42%')
    expect(usagePanel).not.toHaveTextContent('使用率')
    expect(usagePanel).not.toHaveTextContent('总额度')
    expect(usagePanel).not.toHaveTextContent('额度与计费说明')
    expect(usagePanel).not.toHaveClass('pl-12')
    expect(within(usagePanel).queryByRole('progressbar')).not.toBeInTheDocument()
  })

  test('opens the project create menu from the sidebar project create button', async () => {
    const onRefreshDevices = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onRefreshDevices={onRefreshDevices}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'executor',
              status: 'online',
              is_default: true,
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))

    expect(screen.getByTestId('projects-create-button-menu')).toBeInTheDocument()
    expect(screen.getByTestId('project-create-blank-option')).toHaveTextContent('新建空白项目')
    expect(screen.getByTestId('project-create-existing-option')).toHaveTextContent('使用现有文件夹')
    expect(screen.getByTestId('project-create-remote-option')).toHaveTextContent('远程项目')
    expect(screen.queryByTestId('project-create-dialog')).not.toBeInTheDocument()
    expect(onRefreshDevices).toHaveBeenCalledTimes(1)
  })

  test('opens project create menu before device refresh completes', async () => {
    let resolveRefreshDevices: (() => void) | undefined
    const onRefreshDevices = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveRefreshDevices = resolve
        })
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onRefreshDevices={onRefreshDevices}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'executor',
              status: 'online',
              is_default: true,
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))

    expect(screen.getByTestId('projects-create-button-menu')).toBeInTheDocument()
    expect(screen.getByTestId('project-create-existing-option')).toBeInTheDocument()
    expect(onRefreshDevices).toHaveBeenCalledTimes(1)

    resolveRefreshDevices?.()
  })

  test('opens a standalone Codex workspace after creating a blank project in Documents', async () => {
    const onGetDeviceHomeDirectory = vi.fn().mockResolvedValue('/home/ubuntu')
    const onCreateDeviceDirectory = vi.fn().mockResolvedValue(undefined)
    const onOpenStandaloneWorkspace = vi.fn()

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'local-device',
              name: 'Local Device',
              status: 'online',
              is_default: true,
              device_type: 'local',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-blank-option'))
    expect(screen.getByTestId('standalone-blank-project-dialog')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('save-standalone-blank-project-button'))

    await waitFor(() =>
      expect(onCreateDeviceDirectory).toHaveBeenCalledWith(
        'local-device',
        '/home/ubuntu/Documents/New project'
      )
    )
    expect(onOpenStandaloneWorkspace).toHaveBeenCalledWith(
      'local-device',
      '/home/ubuntu/Documents/New project',
      'New project'
    )
  })

  test('keeps the blank project dialog open when runtime workspace registration fails', async () => {
    const onGetDeviceHomeDirectory = vi.fn().mockResolvedValue('/home/ubuntu')
    const onCreateDeviceDirectory = vi.fn().mockResolvedValue(undefined)
    const onOpenStandaloneWorkspace = vi.fn().mockRejectedValue(new Error('register failed'))

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'local-device',
              name: 'Local Device',
              status: 'online',
              is_default: true,
              device_type: 'local',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-blank-option'))
    await userEvent.click(screen.getByTestId('save-standalone-blank-project-button'))

    expect(await screen.findByText('register failed')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-blank-project-dialog')).toBeInTheDocument()
  })

  test('renames a blank project directory when the requested name already exists', async () => {
    const onGetDeviceHomeDirectory = vi.fn().mockResolvedValue('/home/ubuntu')
    const onListDeviceDirectories = vi.fn().mockResolvedValue(['New project', 'New project 2'])
    const onCreateDeviceDirectory = vi.fn().mockResolvedValue(undefined)
    const onOpenStandaloneWorkspace = vi.fn()

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'local-device',
              name: 'Local Device',
              status: 'online',
              is_default: true,
              device_type: 'local',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-blank-option'))
    await userEvent.click(screen.getByTestId('save-standalone-blank-project-button'))

    await waitFor(() =>
      expect(onListDeviceDirectories).toHaveBeenCalledWith('local-device', '/home/ubuntu/Documents')
    )
    expect(onCreateDeviceDirectory).toHaveBeenCalledWith(
      'local-device',
      '/home/ubuntu/Documents/New project 3'
    )
    expect(onOpenStandaloneWorkspace).toHaveBeenCalledWith(
      'local-device',
      '/home/ubuntu/Documents/New project 3',
      'New project'
    )
  })

  test('remote project device picker includes cloud and remote devices but not local devices', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'local-device',
              name: 'Local Device',
              status: 'online',
              is_default: true,
              device_type: 'local',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
            {
              id: 2,
              device_id: 'cloud-device',
              name: 'Cloud Device',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
              runtime_transfer_host: '10.201.3.200',
            },
            {
              id: 3,
              device_id: 'remote-device',
              name: 'Remote Device',
              status: 'online',
              is_default: false,
              device_type: 'remote',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))

    const select = screen.getByTestId('standalone-remote-device-select')
    expect(select).toHaveTextContent('10.201.3.200 · Cloud Device')
    expect(select).toHaveTextContent('Remote Device')
    expect(select).not.toHaveTextContent('Local Device')
  })

  test('remote project dialog excludes incompatible non-local devices', async () => {
    const onUpgradeDevice = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onUpgradeDevice={onUpgradeDevice}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'old-device',
              name: 'Old Device',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.4',
              slot_used: 0,
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-folder-no-device')).toHaveTextContent('连接一台云端设备')
    expect(screen.getByTestId('standalone-folder-no-device')).toHaveTextContent('启动脚本')
    expect(screen.queryByTestId('standalone-remote-device-select')).not.toBeInTheDocument()
    expect(onUpgradeDevice).not.toHaveBeenCalled()
  })

  test('closes the project create menu on outside pointer down', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('projects-create-button'))
    expect(screen.getByTestId('projects-create-button-menu')).toBeInTheDocument()

    fireEvent.pointerMove(document, { clientX: 500, clientY: 500 })
    expect(screen.getByTestId('projects-create-button-menu')).toBeInTheDocument()

    await userEvent.hover(screen.getByTestId('project-row-1'))
    expect(screen.getByTestId('projects-create-button-menu')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('projects-create-button-menu')).not.toBeInTheDocument()
  })

  test('renders the project create menu as a right-floating overlay', async () => {
    const getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function () {
        const element = this as HTMLElement

        if (element.dataset.testid === 'projects-create-button') {
          return createRect({ left: 104, top: 246, width: 28, height: 28 })
        }

        if (element.dataset.testid === 'projects-create-button-menu') {
          return createRect({ left: 0, top: 0, width: 176, height: 76 })
        }

        return createRect({ left: 0, top: 0, width: 0, height: 0 })
      })

    try {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 1024,
      })
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: 720,
      })

      render(<DesktopWorkbenchLayout {...baseProps} />)

      const trigger = screen.getByTestId('projects-create-button')
      await userEvent.click(trigger)

      const menu = screen.getByTestId('projects-create-button-menu')
      expect(menu).toBeInTheDocument()
      expect(document.body).toContainElement(menu)
      expect(document.querySelector('aside')).not.toContainElement(menu)
      expect(menu).toHaveClass('fixed')
      expect(menu).toHaveStyle({ left: '140px', top: '282px', width: '248px' })
    } finally {
      getBoundingClientRectSpy.mockRestore()
    }
  })

  test('renders standalone folder dialog as a page-level overlay', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-existing-option'))

    const dialog = screen.getByTestId('standalone-folder-project-dialog')
    const overlay = dialog.parentElement

    expect(overlay).not.toBeNull()
    expect(document.body).toContainElement(overlay)
    expect(document.querySelector('aside')).not.toContainElement(overlay)
    expect(overlay).toHaveClass('fixed', 'inset-0')
  })

  test('opens blank project dialog from the project work menu add option', async () => {
    const onRefreshDevices = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onRefreshDevices={onRefreshDevices}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'executor',
              status: 'online',
              is_default: true,
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    const menu = screen.getByTestId('project-work-menu')
    const addLocalProjectOption = screen.getByTestId('add-local-project-option')
    expect([...menu.querySelectorAll('button')].map(button => button.dataset.testid)).toEqual([
      'add-local-project-option',
      'add-remote-project-option',
      'no-project-option',
    ])

    await userEvent.hover(addLocalProjectOption)
    await userEvent.click(screen.getByTestId('add-local-blank-project-option'))

    expect(onRefreshDevices).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('project-work-menu')).not.toBeInTheDocument()
    expect(screen.queryByTestId('add-local-project-submenu')).not.toBeInTheDocument()
    expect(screen.getByTestId('standalone-blank-project-dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '为项目命名' })).toBeInTheDocument()
    expect(screen.getByTestId('standalone-blank-project-name-input')).toHaveValue('New project')
  })

  test('shows an empty remote project dialog when there are no remote or cloud devices', async () => {
    const onRefreshDevices = vi.fn().mockResolvedValue(undefined)

    render(<DesktopWorkbenchLayout {...baseProps} onRefreshDevices={onRefreshDevices} />)

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-folder-no-device')).toHaveTextContent('连接一台云端设备')
    expect(screen.getByTestId('standalone-folder-no-device')).toHaveTextContent('启动脚本')
  })

  test('opens the standalone remote dialog from the project work menu', async () => {
    const onRefreshDevices = vi.fn().mockResolvedValue(undefined)

    render(<DesktopWorkbenchLayout {...baseProps} onRefreshDevices={onRefreshDevices} />)

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('add-remote-project-option'))

    expect(onRefreshDevices).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '添加远程项目' })).toBeInTheDocument()
  })

  test('opens a standalone Codex workspace from an existing folder selected in the directory tree', async () => {
    const onCreateProject = vi.fn().mockResolvedValue({ id: 2, name: 'repo', tasks: [] })
    const onPrepareDeviceWorkspace = vi.fn().mockResolvedValue({
      preparedAction: 'selected',
      mapping: {
        id: 10,
        userId: 1,
        projectId: 2,
        deviceId: 'device-1',
        workspacePath: '/home/ubuntu/repo',
        repoUrl: null,
        repoRootFingerprint: null,
        label: null,
        createdAt: '2026-06-21T00:00:00',
        updatedAt: '2026-06-21T00:00:00',
        lastSeenAt: null,
      },
    })
    const onGetDeviceHomeDirectory = vi.fn().mockResolvedValue('/home/ubuntu')
    const onListDeviceDirectories = vi.fn().mockResolvedValue(['.cache', 'repo'])
    const onOpenStandaloneWorkspace = vi.fn()

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onCreateProject={onCreateProject}
        onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'sifang-executor',
              status: 'online',
              is_default: true,
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-existing-option'))

    await waitFor(() => expect(onGetDeviceHomeDirectory).toHaveBeenCalledWith('device-1'))
    await waitFor(() =>
      expect(onListDeviceDirectories).toHaveBeenCalledWith('device-1', '/home/ubuntu')
    )
    expect(screen.queryByText('.cache')).not.toBeInTheDocument()
    expect(screen.getByTestId('confirm-device-folder-picker-button')).toBeInTheDocument()

    const repoEntry = await screen.findByText('repo')
    await userEvent.click(repoEntry)
    expect(onListDeviceDirectories).not.toHaveBeenCalledWith('device-1', '/home/ubuntu/repo')

    await userEvent.click(screen.getByTestId('device-folder-hidden-toggle'))
    expect(screen.getByText('.cache')).toBeInTheDocument()

    await userEvent.dblClick(repoEntry)
    await waitFor(() =>
      expect(onListDeviceDirectories).toHaveBeenCalledWith('device-1', '/home/ubuntu/repo')
    )

    await userEvent.click(screen.getByTestId('confirm-device-folder-picker-button'))
    expect(onOpenStandaloneWorkspace).toHaveBeenCalledWith('device-1', '/home/ubuntu/repo')
    expect(onCreateProject).not.toHaveBeenCalled()
    expect(onPrepareDeviceWorkspace).not.toHaveBeenCalled()
  })

  test('shows project device network status for non-local devices when multiple devices exist', () => {
    const onlineDevice = {
      id: 1,
      device_id: 'online-device',
      name: 'Online Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      client_ip: '127.0.0.1',
      runtime_transfer_host: '192.0.2.10:9000',
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [
            onlineDevice,
            {
              id: 2,
              device_id: 'local-device',
              name: 'Local Device',
              status: 'online' as const,
              is_default: true,
              device_type: 'local' as const,
              bind_shell: 'claudecode',
            },
          ],
          projects: [
            {
              id: 7,
              name: 'hello',
              config: {
                execution: {
                  targetType: 'cloud',
                  deviceId: 'online-device',
                },
              },
              tasks: [],
            },
          ],
        }}
      />
    )

    const projectRow = screen.getByTestId('project-row-7')
    expect(within(projectRow).getByTestId('project-device-status-7')).toHaveTextContent(
      '192.0.2.10'
    )
    expect(within(projectRow).getByTestId('project-new-conversation-button')).not.toBeDisabled()
  })

  test('hides project device network status when only one device exists', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'online-device',
              name: 'Online Device',
              status: 'online' as const,
              is_default: false,
              device_type: 'cloud' as const,
              bind_shell: 'claudecode',
              runtime_transfer_host: '192.0.2.10:9000',
            },
          ],
          projects: [
            {
              id: 7,
              name: 'hello',
              config: {
                execution: {
                  targetType: 'cloud',
                  deviceId: 'online-device',
                },
              },
              tasks: [],
            },
          ],
        }}
      />
    )

    const projectRow = screen.getByTestId('project-row-7')
    expect(within(projectRow).queryByTestId('project-device-status-7')).not.toBeInTheDocument()
  })

  test('hides project device network status for local devices when multiple devices exist', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'local-device',
              name: 'Local Device',
              status: 'online' as const,
              is_default: true,
              device_type: 'local' as const,
              bind_shell: 'claudecode',
              runtime_transfer_host: '192.0.2.10:9000',
            },
            {
              id: 2,
              device_id: 'cloud-device',
              name: 'Cloud Device',
              status: 'online' as const,
              is_default: false,
              device_type: 'cloud' as const,
              bind_shell: 'claudecode',
            },
          ],
          projects: [
            {
              id: 7,
              name: 'hello',
              config: {
                execution: {
                  targetType: 'local',
                  deviceId: 'local-device',
                },
              },
              tasks: [],
            },
          ],
        }}
      />
    )

    const projectRow = screen.getByTestId('project-row-7')
    expect(within(projectRow).queryByTestId('project-device-status-7')).not.toBeInTheDocument()
  })

  test('keeps offline project conversations readable but locks the composer', async () => {
    const offlineDevice = {
      id: 1,
      device_id: 'offline-device',
      name: 'Offline Device',
      status: 'offline' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
    const project = {
      id: 7,
      name: 'hello',
      config: {
        execution: {
          targetType: 'cloud' as const,
          deviceId: 'offline-device',
        },
      },
      tasks: [],
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          projects: [project],
          devices: [offlineDevice],
          currentProject: project,
          input: 'hello offline',
        }}
        messages={[
          {
            id: 'message-1',
            role: 'user',
            content: 'hello',
            status: 'done',
            createdAt: new Date().toISOString(),
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: [project],
          devices: [offlineDevice],
          currentProjectId: 7,
        }}
      />
    )

    expect(screen.getByTestId('desktop-chat-scroll')).toHaveTextContent('hello')
    expect(screen.getByTestId('conversation-device-offline-banner')).toHaveTextContent(
      'Offline Device 已离线，恢复在线后可继续对话'
    )
    expect(screen.queryByTestId('composer-disabled-reason')).not.toBeInTheDocument()
    expect(screen.queryByTestId('device-status-prompt')).not.toBeInTheDocument()
    expect(screen.getByTestId('send-message-button')).toBeDisabled()

    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(baseProps.onSend).not.toHaveBeenCalled()
  })

  test('keeps the composer available without an inline notice while runtime task is running', async () => {
    const onSend = vi.fn()
    const onlineDevice = {
      id: 1,
      device_id: 'device-1',
      name: 'Runtime Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        currentRuntimeTaskRunning
        state={{
          ...baseProps.state,
          devices: [onlineDevice],
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-a',
          },
          input: '继续修',
        }}
        messages={[
          {
            id: 'message-1',
            role: 'user',
            content: '执行pwd',
            status: 'done',
            createdAt: new Date().toISOString(),
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          devices: [onlineDevice],
        }}
        onSend={onSend}
      />
    )

    expect(screen.queryByTestId('composer-disabled-reason')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-message-input')).toHaveAttribute('placeholder', '要求后续变更')
    expect(screen.getByTestId('send-message-button')).not.toBeDisabled()

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(onSend).toHaveBeenCalledTimes(1)
  })

  test('hides inline composer notice while a send request is in flight', async () => {
    const onlineDevice = {
      id: 1,
      device_id: 'device-1',
      name: 'Runtime Device',
      status: 'online' as const,
      is_default: true,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [onlineDevice],
          standaloneDeviceId: 'device-1',
          input: '正在发送的消息',
          isSending: true,
        }}
        projectWork={{
          ...baseProps.projectWork,
          devices: [onlineDevice],
          currentStandaloneDeviceId: 'device-1',
        }}
      />
    )

    expect(screen.queryByTestId('composer-disabled-reason')).not.toBeInTheDocument()
    expect(screen.getByTestId('send-message-button')).toBeDisabled()
  })

  test('shows an external upgrade action for the active low-version device', async () => {
    const onUpgradeDevice = vi.fn().mockResolvedValue(undefined)
    const oldDevice = {
      id: 1,
      device_id: 'old-device',
      name: 'Old Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.4',
      slot_used: 0,
    }
    const compatibleDevice = {
      id: 2,
      device_id: 'compatible-device',
      name: 'Compatible Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
    const project = {
      id: 7,
      name: 'hello',
      config: {
        execution: {
          targetType: 'cloud' as const,
          deviceId: 'old-device',
        },
      },
      tasks: [],
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onUpgradeDevice={onUpgradeDevice}
        state={{
          ...baseProps.state,
          projects: [project],
          devices: [oldDevice, compatibleDevice],
          currentProject: project,
          input: 'hello old device',
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: [project],
          devices: [oldDevice, compatibleDevice],
          currentProjectId: 7,
        }}
      />
    )

    expect(screen.getByTestId('composer-disabled-reason')).toHaveTextContent(
      'Old Device 版本低于 1.8.5，升级后可继续对话'
    )
    expect(screen.getByTestId('device-status-prompt')).toHaveTextContent(
      'Old Device 版本低于 1.8.5，升级后可继续对话'
    )
    expect(screen.getByTestId('send-message-button')).toBeDisabled()

    await userEvent.click(screen.getByTestId('device-status-upgrade-button'))

    expect(onUpgradeDevice).toHaveBeenCalledWith('old-device')
  })

  test('keeps projects and chats in the scrollable sidebar region above settings', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('sidebar-worklists-scroll')).toHaveClass(
      'flex-1',
      'overflow-y-auto',
      'scrollbar-none',
      '[overflow-anchor:none]'
    )
    expect(screen.getByTestId('settings-button')).toHaveClass('h-14', 'min-w-0', 'flex-1')
    expect(screen.getByTestId('settings-button')).not.toHaveClass('w-full')
    expect(screen.getByTestId('sidebar-global-im-notification-button')).toHaveClass('h-8', 'w-8')
  })

  test('selects a project while toggling its empty task list', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('runtime-chat-empty')).toHaveTextContent('暂无会话')
    expect(screen.getByTestId('project-local-tasks-panel-1')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('project-row-1')).not.toHaveClass('bg-white')

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(baseProps.onSelectProject).toHaveBeenCalledWith(1)
    expect(screen.getByTestId('project-local-tasks-panel-1')).toHaveAttribute(
      'aria-hidden',
      'false'
    )
    expect(screen.getByTestId('project-local-tasks-empty-1')).toHaveTextContent('暂无会话')
    expect(screen.getByTestId('project-row-1')).not.toHaveClass('bg-white')

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.getByTestId('project-local-tasks-panel-1')).toHaveAttribute('aria-hidden', 'true')
    expect(baseProps.onSelectProject).toHaveBeenCalledTimes(2)
  })

  test('opens the independent connection settings page from the settings menu', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('settings-button'))
    await userEvent.click(screen.getByTestId('settings-menu-button'))

    expect(screen.getByTestId('wework-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-back-button')).toHaveTextContent('返回')
    expect(screen.queryByText('返回应用')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '云端设置' })).toBeInTheDocument()
    expect(screen.getByText('已连接云端')).toBeInTheDocument()
    expect(screen.getByText('当前域名:')).toBeInTheDocument()
    expect(screen.getByText('云端模型')).toBeInTheDocument()
    expect(screen.getByText('云端设备')).toBeInTheDocument()
    expect(screen.queryByText('连接这台设备')).not.toBeInTheDocument()
    expect(screen.queryByText('链接这台设备')).not.toBeInTheDocument()
    expect(screen.queryByText('控制其他设备')).not.toBeInTheDocument()
    expect(screen.queryByText('SSH')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-connections')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-nav-projects')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-nav-general')).not.toBeInTheDocument()
    expect(screen.queryByText('Personal Devices')).not.toBeInTheDocument()
    expect(screen.queryByText('Linux-Device-481b616e8e0b')).not.toBeInTheDocument()
    expect(screen.queryByText('可连接这台设备的云设备')).not.toBeInTheDocument()
    expect(await screen.findByText('云设备')).toBeInTheDocument()
    expect(
      screen.getByTestId('connection-device-24a59054-4638-4744-983d-372706c30fcd')
    ).toBeInTheDocument()
    expect(screen.getByText('yunpeng7-executor-372706c30fcd')).toBeInTheDocument()
    expect(screen.getByText('v1.712')).toBeInTheDocument()
    expect(screen.getByText('在线')).toBeInTheDocument()
    expect(screen.queryByText('Online')).not.toBeInTheDocument()
    expect(
      screen.getByTestId('connection-terminal-button-24a59054-4638-4744-983d-372706c30fcd')
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('connection-code-server-button-24a59054-4638-4744-983d-372706c30fcd')
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('connection-vnc-button-24a59054-4638-4744-983d-372706c30fcd')
    ).toBeInTheDocument()
    expect(screen.getByText('终端')).toBeInTheDocument()
    expect(screen.getByText('IDE')).toBeInTheDocument()
    expect(screen.getByText('桌面')).toBeInTheDocument()
    expect(screen.queryByText('Terminal')).not.toBeInTheDocument()
    expect(screen.queryByText('Code Server')).not.toBeInTheDocument()
    expect(screen.queryByText('桌面 VNC')).not.toBeInTheDocument()
    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(screen.getByText('MEM')).toBeInTheDocument()
    expect(screen.getByText('磁盘')).toBeInTheDocument()
    expect(await screen.findByText('42%')).toBeInTheDocument()
    expect(screen.getByText('68%')).toBeInTheDocument()
    expect(screen.getByText('57%')).toBeInTheDocument()
    expect(screen.getByTestId('connection-scale-wiki')).toBeInTheDocument()
    expect(screen.getByText('说明')).toBeInTheDocument()
    expect(screen.queryByText('扩容 Wiki')).not.toBeInTheDocument()
    expect(screen.getByText(/持续超过 80%/)).toBeInTheDocument()
    expect(screen.queryByText('a8791aa3-4e8a-4076-b9a6-481b616e8e0b')).not.toBeInTheDocument()
    expect(screen.queryByText('Nevis')).not.toBeInTheDocument()
    expect(screen.queryByText('Cloud computing powered by Nevis')).not.toBeInTheDocument()
    expect(screen.queryByText('其他设置')).not.toBeInTheDocument()
    expect(screen.queryByText('Start Task')).not.toBeInTheDocument()
  })

  test('opens and resizes the right workspace panel', async () => {
    renderWorkspacePanelLayout({ mainWidth: 1000 })

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    const panel = screen.getByTestId('right-workspace-panel')
    expect(panel).toBeInTheDocument()
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-review-option')).toHaveTextContent('审查')
    expect(screen.getByTestId('right-workspace-browser-option')).toHaveTextContent('浏览器')
    expect(screen.getByTestId('right-workspace-file-option')).toHaveTextContent('文件')
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-tool-launcher')).not.toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-resize-handle')).toHaveAttribute('role', 'separator')
    expect(screen.getByTestId('right-workspace-resize-handle')).toHaveClass(
      'absolute',
      'bottom-[-6px]',
      'top-0',
      'w-1.5',
      '-translate-x-1/2',
      'cursor-col-resize'
    )
    expect(screen.getByTestId('right-workspace-resize-handle')).toHaveStyle({ left: '420px' })

    const content = screen.getByTestId('desktop-workbench-content')
    const rightPanelShell = screen.getByTestId('right-workspace-panel-shell')
    await waitFor(() => {
      expect(content).toHaveStyle({ width: '420px' })
      expect(rightPanelShell).toHaveStyle({ width: 'calc(100% - 420px)' })
    })
    expect(panel).toHaveClass('min-w-0', 'flex-1', 'basis-0')
    expect(panel).toHaveClass('transition-[opacity,transform]', 'duration-300', 'ease-out')
    expect(content).toHaveClass(
      'transition-[width]',
      'duration-[240ms]',
      'ease-[cubic-bezier(0.2,0,0,1)]'
    )

    fireEvent.pointerDown(screen.getByTestId('right-workspace-resize-handle'), { clientX: 422 })
    fireEvent.pointerMove(document, { clientX: 582 })
    fireEvent.pointerUp(document)

    expect(content).toHaveStyle({ width: '580px' })
    expect(rightPanelShell).toHaveStyle({ width: 'calc(100% - 580px)' })
    expect(screen.getByTestId('workspace-file-tree')).toHaveClass('w-[240px]')
  })

  test('opens the browser from the right workspace launcher row', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))

    const browserTab = screen.getByTestId('right-workspace-browser-tab')
    expect(browserTab).toHaveAttribute('role', 'tab')
    expect(browserTab).toHaveAttribute('aria-selected', 'true')
    expect(browserTab).toHaveTextContent(/^新选项卡$/)
    expect(within(browserTab).getByTestId('right-workspace-browser-tab-icon')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-browser-panel')).toHaveClass('bg-background')
    expect(screen.getByTestId('workspace-browser-url-input')).toBeInTheDocument()

    await userEvent.type(screen.getByTestId('workspace-browser-url-input'), 'weibo.com{Enter}')

    expect(browserTab).toHaveTextContent(/^weibo.com$/)
    expect(within(browserTab).getByTestId('right-workspace-browser-tab-favicon')).toHaveAttribute(
      'src',
      'https://weibo.com/favicon.ico'
    )
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'https://weibo.com/'
    )
    expect(screen.getByTestId('workspace-browser-frame')).toHaveClass('bg-background')
  })

  test('preserves the browser tab after closing and reopening the right workspace area', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))
    await userEvent.type(screen.getByTestId('workspace-browser-url-input'), 'weibo.com{Enter}')

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    const rightPanelShell = screen.getByTestId('right-workspace-panel-shell')
    expect(rightPanelShell).toHaveAttribute('aria-hidden', 'true')
    expect(rightPanelShell).toHaveStyle({ width: '0px' })
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-browser-panel')).toHaveClass('hidden')
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://weibo.com/')
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'https://weibo.com/'
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(rightPanelShell).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByTestId('right-workspace-browser-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('workspace-browser-panel')).not.toHaveClass('hidden')
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://weibo.com/')
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'https://weibo.com/'
    )
  })

  test('resizes the browser area while dragging and collapses the right panel at the edge', async () => {
    renderWorkspacePanelLayout({ mainWidth: 1000 })

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))
    await userEvent.type(screen.getByTestId('workspace-browser-url-input'), 'weibo.com{Enter}')

    vi.spyOn(getDesktopWorkbenchMainElement(), 'getBoundingClientRect').mockReturnValue(
      createRect({ left: 0, top: 0, width: 1000, height: 720 })
    )

    const content = screen.getByTestId('desktop-workbench-content')
    const rightPanelShell = screen.getByTestId('right-workspace-panel-shell')

    await waitFor(() => {
      expect(content).toHaveStyle({ width: '420px' })
      expect(rightPanelShell).toHaveStyle({ width: 'calc(100% - 420px)' })
    })

    fireEvent.pointerDown(screen.getByTestId('right-workspace-resize-handle'), { clientX: 422 })
    fireEvent.pointerMove(document, { clientX: 702 })

    expect(content).toHaveClass('transition-none')
    expect(rightPanelShell).toHaveClass('transition-none')
    expect(content).toHaveStyle({ width: '700px' })
    expect(rightPanelShell).toHaveStyle({ width: 'calc(100% - 700px)' })

    fireEvent.pointerMove(document, { clientX: 902 })

    await waitFor(() => {
      expect(rightPanelShell).toHaveAttribute('aria-hidden', 'true')
      expect(rightPanelShell).toHaveStyle({ width: '0px' })
      expect(screen.queryByTestId('right-workspace-resize-handle')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://weibo.com/')
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(content).toHaveStyle({ width: '420px' })
    expect(rightPanelShell).toHaveStyle({ width: 'calc(100% - 420px)' })
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://weibo.com/')
  })

  test('does not leave the browser loading when submitting the current URL again', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))

    const urlInput = screen.getByTestId('workspace-browser-url-input')
    await userEvent.type(urlInput, 'weibo.com{Enter}')
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'https://weibo.com/'
    )

    await userEvent.type(urlInput, '{Enter}')

    await waitFor(() =>
      expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
        'src',
        'https://weibo.com/'
      )
    )
    expect(screen.queryByTestId('workspace-browser-loading')).not.toBeInTheDocument()
  })

  test('keeps one browser tab and preserves it when opening files from the new tab menu', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))
    await userEvent.type(screen.getByTestId('workspace-browser-url-input'), 'weibo.com{Enter}')

    await userEvent.click(screen.getByTestId('right-workspace-new-tab-button'))

    const menu = screen.getByTestId('right-workspace-new-tab-menu')
    expect(menu).toBeInTheDocument()
    expect(within(menu).queryByTestId('right-workspace-browser-option')).not.toBeInTheDocument()
    expect(within(menu).getByTestId('right-workspace-file-option')).toHaveTextContent('文件')

    await userEvent.click(within(menu).getByTestId('right-workspace-file-option'))

    expect(screen.queryByTestId('right-workspace-new-tab-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://weibo.com/')
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'https://weibo.com/'
    )

    await userEvent.click(screen.getByTestId('right-workspace-browser-tab'))

    expect(screen.getByTestId('right-workspace-browser-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://weibo.com/')
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'https://weibo.com/'
    )
  })

  test('opens the right workspace new tab menu as an anchored popup in Tauri', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))

    const newTabButton = screen.getByTestId('right-workspace-new-tab-button')
    ;(window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}

    await userEvent.click(newTabButton)

    const menu = screen.getByTestId('right-workspace-new-tab-menu')
    expect(menu).toBeInTheDocument()
    expect(within(menu).getByTestId('right-workspace-review-option')).toHaveTextContent('审查')
    expect(within(menu).getByTestId('right-workspace-terminal-option')).toHaveTextContent('终端')
    expect(within(menu).queryByTestId('right-workspace-browser-option')).not.toBeInTheDocument()
    expect(within(menu).getByTestId('right-workspace-file-option')).toHaveTextContent('文件')
    expect(tauriMenuMocks.menuNew).not.toHaveBeenCalled()
    expect(tauriMenuMocks.menuPopup).not.toHaveBeenCalled()
  })

  test('opens terminal in the right workspace panel from the right add menu', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    await userEvent.click(screen.getByTestId('right-workspace-new-tab-button'))

    const menu = screen.getByTestId('right-workspace-new-tab-menu')
    await userEvent.click(within(menu).getByTestId('right-workspace-terminal-option'))

    expect(screen.queryByTestId('right-workspace-new-tab-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-terminal-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('bottom-workspace-panel')).toHaveAttribute('aria-hidden', 'true')
    await waitFor(() => expect(startTerminalSessionMock).toHaveBeenCalledWith(12))
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')
  })

  test('right workspace panel pushes the conversation chat into a narrow split column', async () => {
    mockDesktopWorkbenchMainWidth(1000)
    const workspacePanelState = createCloudWorkspacePanelState()
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    const content = screen.getByTestId('desktop-workbench-content')
    const topBar = screen.getByTestId('workbench-topbar')
    const rightPanelShell = screen.getByTestId('right-workspace-panel-shell')
    expect(topBar).toHaveStyle({ width: '100%' })
    expect(content).toHaveClass(
      'flex-none',
      'transition-[width]',
      'duration-[240ms]',
      'ease-[cubic-bezier(0.2,0,0,1)]'
    )
    expect(content).toHaveStyle({ width: '100%' })
    expect(rightPanelShell).toHaveClass(
      'overflow-hidden',
      'opacity-0',
      'transition-[width,opacity]',
      'duration-[240ms]',
      'ease-[cubic-bezier(0.2,0,0,1)]'
    )
    expect(rightPanelShell).toHaveStyle({ width: '0px' })
    expect(screen.queryByTestId('right-workspace-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('desktop-floating-composer-layer')).toHaveClass(
      'w-[min(46rem,calc(100%_-_2rem))]',
      'min-w-0',
      'max-w-[calc(100%_-_2rem)]'
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(content).toHaveClass(
      'flex-none',
      'transition-[width]',
      'duration-[240ms]',
      'ease-[cubic-bezier(0.2,0,0,1)]'
    )
    expect(content).not.toHaveClass('border-r')
    await waitFor(() => {
      expect(content).toHaveStyle({ width: '420px' })
      expect(topBar).toHaveStyle({ width: '420px' })
      expect(rightPanelShell).toHaveStyle({ width: 'calc(100% - 420px)' })
    })
    expect(rightPanelShell).toHaveClass('opacity-100')
    expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-bottom-workspace-panel-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toHaveClass('right-8', 'gap-1')
    expect(screen.getByTestId('right-workspace-panel')).toHaveClass(
      'min-w-0',
      'flex-1',
      'basis-0',
      'transition-[opacity,transform]',
      'duration-300',
      'ease-out'
    )
    expect(screen.getByTestId('desktop-floating-composer-layer')).toHaveClass(
      'w-[min(46rem,calc(100%_-_2rem))]',
      'min-w-0',
      'max-w-[calc(100%_-_2rem)]'
    )
    expect(screen.getByTestId('desktop-chat-scroll-content').firstElementChild).toHaveClass(
      'w-[min(46rem,calc(100%_-_6rem))]',
      'min-w-0',
      'max-w-[calc(100%_-_6rem)]',
      'px-0'
    )
  })

  test('right workspace panel opens the file tab from the launcher', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-option')).toHaveClass(
      'h-11',
      'rounded-xl',
      'font-light'
    )
    expect(screen.getByTestId('right-workspace-file-option')).toHaveTextContent('⌥⌘F')
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))

    const tabbar = screen.getByTestId('right-workspace-tabbar')
    const fileTab = screen.getByTestId('right-workspace-file-tab')
    expect(tabbar).toHaveAttribute('role', 'tablist')
    expect(screen.queryByTestId('right-workspace-review-tab')).not.toBeInTheDocument()
    expect(fileTab).toHaveAttribute('role', 'tab')
    expect(fileTab).toHaveAttribute('aria-selected', 'true')
    expect(fileTab).toHaveTextContent(/^文件$/)
    expect(fileTab).toHaveClass('group/tab')
    const closeButton = within(fileTab).getByTestId('right-workspace-file-tab-close-button')
    expect(closeButton.parentElement).toHaveClass(
      'absolute',
      'right-1',
      'opacity-0',
      'group-hover/tab:opacity-100',
      'focus-within:opacity-100'
    )
    expect(closeButton).toHaveClass(
      'h-[18px]',
      'w-[18px]',
      'rounded-full',
      'hover:bg-black/70',
      'hover:text-white'
    )
    expect(closeButton).not.toHaveClass('ml-auto')
    expect(closeButton).not.toHaveClass('border', 'bg-muted')
    expect(screen.getByTestId('right-workspace-new-tab-button')).toBeInTheDocument()
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
  })

  test('right workspace launcher keyboard shortcut opens the file tab', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'f', metaKey: true, altKey: true })

    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
  })

  test('right workspace can open multiple temporary chat tabs', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-chat-option'))

    const tabbar = screen.getByTestId('right-workspace-tabbar')
    expect(screen.getByTestId('right-workspace-chat-panel')).toBeInTheDocument()
    expect(within(tabbar).getAllByText('临时聊天')).toHaveLength(1)

    await userEvent.click(screen.getByTestId('right-workspace-new-tab-button'))
    await userEvent.click(
      within(screen.getByTestId('right-workspace-new-tab-menu')).getByTestId(
        'right-workspace-chat-option'
      )
    )

    expect(within(tabbar).getAllByText('临时聊天')).toHaveLength(2)
    expect(screen.getByTestId('right-workspace-chat-panel')).toBeInTheDocument()
  })

  test('moves right workspace tabs into the titlebar in Tauri', async () => {
    const previousTauriInternals = (window as typeof window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    try {
      renderWorkspacePanelLayout({ mainWidth: 1000 })

      await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
      expect(screen.queryByTestId('right-workspace-titlebar-spacer')).not.toBeInTheDocument()

      await userEvent.click(screen.getByTestId('right-workspace-file-option'))

      const titlebarRightPanel = screen.getByTestId('titlebar-right-panel')
      expect(screen.getByTestId('titlebar-right-workspace-zone')).toHaveClass(
        'absolute',
        'right-0',
        'top-0',
        'h-full'
      )
      expect(screen.getByTestId('titlebar-right-workspace-zone')).toHaveClass('border-l')
      expect(screen.getByTestId('titlebar-actions')).toHaveClass('min-w-[5rem]')
      expect(screen.getByTestId('titlebar-actions')).toContainElement(
        screen.getByTestId('toggle-right-workspace-panel-button')
      )
      expect(screen.getByTestId('titlebar-right-workspace-zone')).toHaveStyle({
        width: 'calc(100% - 420px)',
      })
      expect(screen.getByTestId('right-workspace-resize-handle')).toHaveClass(
        'after:bg-transparent'
      )
      const tabbar = screen.getByTestId('right-workspace-tabbar')
      expect(titlebarRightPanel).toContainElement(tabbar)
      expect(titlebarRightPanel).toContainElement(screen.getByTestId('right-workspace-file-tab'))
      expect(titlebarRightPanel).toContainElement(
        screen.getByTestId('right-workspace-new-tab-button')
      )
      const rightTitlebarDragRegion = screen.getByTestId('right-workspace-titlebar-drag-region')
      expect(titlebarRightPanel).toContainElement(rightTitlebarDragRegion)
      expect(
        within(rightTitlebarDragRegion).getByTestId('macos-titlebar-drag-region')
      ).toHaveAttribute('data-tauri-drag-region')
      expect(screen.getByTestId('right-workspace-file-tab')).not.toContainElement(
        rightTitlebarDragRegion
      )
      expect(screen.getByTestId('right-workspace-new-tab-button')).not.toContainElement(
        rightTitlebarDragRegion
      )
      expect(screen.queryByTestId('right-workspace-titlebar-spacer')).not.toBeInTheDocument()
      await userEvent.click(screen.getByTestId('right-workspace-new-tab-button'))
      expect(screen.getByTestId('right-workspace-new-tab-menu')).toBeInTheDocument()
    } finally {
      if (previousTauriInternals === undefined) {
        delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
      } else {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
          configurable: true,
          value: previousTauriInternals,
        })
      }
    }
  })

  test('removes right workspace tabs from the titlebar when the Tauri panel is closed', async () => {
    const previousTauriInternals = (window as typeof window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    try {
      renderWorkspacePanelLayout({ mainWidth: 1000 })

      await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
      await userEvent.click(screen.getByTestId('right-workspace-file-option'))

      const titlebarRightPanel = screen.getByTestId('titlebar-right-panel')
      expect(within(titlebarRightPanel).getByTestId('right-workspace-file-tab')).toBeInTheDocument()

      await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

      const rightPanelShell = screen.getByTestId('right-workspace-panel-shell')
      expect(rightPanelShell).toHaveAttribute('aria-hidden', 'true')
      expect(rightPanelShell).toHaveStyle({ width: '0px' })
      expect(within(titlebarRightPanel).queryByTestId('right-workspace-file-tab')).toBeNull()
      expect(rightPanelShell).toContainElement(screen.getByTestId('right-workspace-file-tab'))
      expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    } finally {
      if (previousTauriInternals === undefined) {
        delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
      } else {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
          configurable: true,
          value: previousTauriInternals,
        })
      }
    }
  })

  test('does not show inactive runtime task right workspace tabs in the Tauri titlebar', async () => {
    const previousTauriInternals = (window as typeof window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    const { propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()

    try {
      mockDesktopWorkbenchMainWidth(1000)
      const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

      await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
      await userEvent.click(screen.getByTestId('right-workspace-file-option'))

      const titlebarRightPanel = screen.getByTestId('titlebar-right-panel')
      expect(within(titlebarRightPanel).getByTestId('right-workspace-file-tab')).toBeInTheDocument()

      rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)

      expect(within(titlebarRightPanel).queryByTestId('right-workspace-file-tab')).toBeNull()
    } finally {
      if (previousTauriInternals === undefined) {
        delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
      } else {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
          configurable: true,
          value: previousTauriInternals,
        })
      }
    }
  })

  test('right workspace panel restores the previous tab after closing and reopening', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-panel-shell')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('right-workspace-panel-shell')).toHaveStyle({ width: '0px' })
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(screen.queryByTestId('right-workspace-launcher')).not.toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
  })

  test('project conversations open files from the project workspace', async () => {
    const workspaceProject = {
      id: 12,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: 'workspace-device',
        },
        workspace: {
          source: 'git' as const,
          checkoutPath: 'projects/abc/Wegent',
        },
      },
    }
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/projects/abc/Wegent',
      entries: [],
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          ...baseProps.workspaceFileApi,
          listWorkspaceEntries,
        }}
        state={{
          ...baseProps.state,
          currentProject: workspaceProject,
          projects: [workspaceProject],
          devices: [
            {
              id: 1,
              device_id: 'workspace-device',
              name: 'Workspace Device',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
        messages={[
          {
            id: 'assistant-1',
            taskId: 99,
            role: 'assistant',
            content: 'stale task output',
            status: 'done',
            createdAt: '2026-06-12T00:00:00.000Z',
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'turn-file-changes/99/100',
              device_id: 'workspace-device',
              workspace_path: '/Users/me/outside-workspace',
              file_count: 0,
              additions: 0,
              deletions: 0,
              files: [],
            },
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: [workspaceProject],
          devices: [
            {
              id: 1,
              device_id: 'workspace-device',
              name: 'Workspace Device',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
          currentProjectId: workspaceProject.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))

    await waitFor(() =>
      expect(listWorkspaceEntries).toHaveBeenCalledWith(
        'workspace-device',
        '/workspace/projects/abc/Wegent'
      )
    )
  })

  test('right workspace panel opens only the review tab from the launcher', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('right-workspace-review-option'))

    const tabbar = screen.getByTestId('right-workspace-tabbar')
    const reviewTab = screen.getByTestId('right-workspace-review-tab')
    expect(tabbar).toHaveAttribute('role', 'tablist')
    expect(reviewTab).toHaveAttribute('role', 'tab')
    expect(reviewTab).toHaveAttribute('aria-selected', 'true')
    expect(reviewTab).toHaveTextContent('审查')
    expect(screen.queryByTestId('right-workspace-file-tab')).not.toBeInTheDocument()
    const closeButton = within(reviewTab).getByTestId('right-workspace-review-tab-close-button')
    expect(reviewTab).toHaveClass('group/tab')
    expect(closeButton.parentElement).toHaveClass(
      'absolute',
      'right-1',
      'opacity-0',
      'group-hover/tab:opacity-100',
      'focus-within:opacity-100'
    )
    expect(closeButton).toHaveClass(
      'h-[18px]',
      'w-[18px]',
      'rounded-full',
      'hover:bg-black/70',
      'hover:text-white'
    )
    expect(closeButton).not.toHaveClass('ml-auto')
    expect(closeButton).not.toHaveClass('border', 'bg-muted')
    expect(screen.getByTestId('right-workspace-new-tab-button')).toBeInTheDocument()
    expect(await screen.findByTestId('file-changes-review-panel')).toHaveTextContent('src/env.ts')
    expect(baseProps.onLoadEnvironmentDiff).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('refresh-review-diff-button'))

    await waitFor(() => expect(baseProps.onLoadEnvironmentDiff).toHaveBeenCalledTimes(2))
  })

  test('right workspace panel retries review loading after a stale device offline error', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    const onLoadEnvironmentDiff = vi
      .fn()
      .mockRejectedValueOnce(new Error("Device 'aa1f5585-8ef4-4cf3-a3c0-d8c89d22831a' is offline"))
      .mockResolvedValueOnce(
        'diff --git a/src/env.ts b/src/env.ts\n--- a/src/env.ts\n+++ b/src/env.ts\n@@ -1 +1 @@\n-old\n+new\n'
      )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentDiff={onLoadEnvironmentDiff}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-review-option'))

    const failedPanel = await screen.findByTestId('file-changes-review-panel')
    expect(failedPanel).toHaveTextContent('设备暂时不可用，请稍后重试')
    expect(failedPanel).not.toHaveTextContent('aa1f5585-8ef4-4cf3-a3c0-d8c89d22831a')
    expect(onLoadEnvironmentDiff).toHaveBeenCalledTimes(1)

    await userEvent.click(
      within(screen.getByTestId('right-workspace-review-tab')).getByTestId(
        'right-workspace-review-tab-close-button'
      )
    )
    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-review-option'))

    await waitFor(() => expect(onLoadEnvironmentDiff).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('file-changes-review-panel')).toHaveTextContent('src/env.ts')
    expect(screen.getByTestId('file-changes-review-panel')).toHaveTextContent('new')
    expect(screen.getByTestId('file-changes-review-panel')).not.toHaveTextContent(
      '设备暂时不可用，请稍后重试'
    )
  })

  test('right workspace panel shows file tree and read-only preview', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const listWorkspaceEntries = vi.fn().mockResolvedValueOnce({
      path: '/workspace/project',
      entries: [
        {
          name: 'src',
          path: '/workspace/project/src',
          isDirectory: true,
          size: 0,
          modifiedAt: null,
        },
        {
          name: 'README.md',
          path: '/workspace/project/README.md',
          isDirectory: false,
          size: 11,
          modifiedAt: null,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/README.md',
      name: 'README.md',
      content: 'hello world',
      truncated: false,
      size: 11,
      modifiedAt: null,
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(screen.getByTestId('right-workspace-file-option'))

    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    await user.click(await screen.findByText('README.md'))

    expect(await screen.findByTestId('workspace-file-preview-code-view')).toBeInTheDocument()
    await waitFor(() => expect(getWorkspaceCodeViewText()).toContain('hello world'))
    expect(getWorkspaceCodeViewText()).toContain('/workspace/project/README.md')
  })

  test('opens an edited file from the conversation tool block in the workspace panel', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/README.md',
      name: 'README.md',
      content: 'opened from tool block',
      truncated: false,
      size: 22,
      modifiedAt: null,
    })
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [],
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        messages={[
          {
            id: 'assistant-editing-file',
            taskId: 101,
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-06-12T00:00:00.000Z',
            blocks: [
              {
                id: 'edit-file-1',
                subtaskId: 101,
                type: 'tool',
                toolName: 'edit_file',
                toolInput: {
                  path: 'README.md',
                  old_string: 'before',
                  new_string: 'after',
                },
                status: 'streaming',
                createdAt: 1770000000000,
              },
            ],
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: /正在编辑 README\.md/ }))

    expect(await screen.findByTestId('workspace-file-preview-code-view')).toBeInTheDocument()
    await waitFor(() => expect(getWorkspaceCodeViewText()).toContain('opened from tool block'))
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(readWorkspaceTextFile).toHaveBeenCalledWith(
      'workspace-cloud-device',
      '/workspace/project/README.md'
    )
  })

  test('right workspace panel renders nested directories as an expanded tree', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const listWorkspaceEntries = vi.fn((_deviceId: string, path: string) => {
      if (path === '/workspace/project/backend') {
        return Promise.resolve({
          path,
          entries: [
            {
              name: 'alembic',
              path: '/workspace/project/backend/alembic',
              isDirectory: true,
              size: 0,
              modifiedAt: null,
            },
            {
              name: 'app',
              path: '/workspace/project/backend/app',
              isDirectory: true,
              size: 0,
              modifiedAt: null,
            },
          ],
        })
      }
      if (path === '/workspace/project/backend/alembic') {
        return Promise.resolve({
          path,
          entries: [
            {
              name: '__pycache__',
              path: '/workspace/project/backend/alembic/__pycache__',
              isDirectory: true,
              size: 0,
              modifiedAt: null,
            },
            {
              name: 'env.py',
              path: '/workspace/project/backend/alembic/env.py',
              isDirectory: false,
              size: 24,
              modifiedAt: null,
            },
          ],
        })
      }
      return Promise.resolve({
        path: '/workspace/project',
        entries: [
          {
            name: 'backend',
            path: '/workspace/project/backend',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
          {
            name: 'frontend',
            path: '/workspace/project/frontend',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
        ],
      })
    })
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          ...baseProps.workspaceFileApi,
          listWorkspaceEntries,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(screen.getByTestId('right-workspace-file-option'))
    await user.click(await screen.findByText('backend'))

    const backendRow = screen
      .getByText('backend')
      .closest('[data-testid="workspace-directory-row"]')
    const alembicRow = await screen.findByText('alembic')
    expect(backendRow).toHaveAttribute('aria-expanded', 'true')
    expect(backendRow).toHaveAttribute('data-depth', '0')
    expect(alembicRow.closest('[data-testid="workspace-directory-row"]')).toHaveAttribute(
      'data-depth',
      '1'
    )
    expect(screen.getByText('frontend')).toBeInTheDocument()

    await user.click(alembicRow)

    const selectedAlembicRow = screen
      .getByText('alembic')
      .closest('[data-testid="workspace-directory-row"]')
    expect(selectedAlembicRow).toHaveClass('ring-1', 'ring-primary')
    expect(await screen.findByText('__pycache__')).toBeInTheDocument()
    expect(
      screen.getByText('env.py').closest('[data-testid="workspace-file-row"]')
    ).toHaveAttribute('data-depth', '2')
    expect(screen.getAllByTestId('workspace-tree-indent-guide').length).toBeGreaterThan(0)
  })

  test('right workspace panel ignores stale file preview responses', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const readmeFile = createDeferred<{
      path: string
      name: string
      content: string
      truncated: boolean
      size: number
      modifiedAt: null
    }>()
    const notesFile = createDeferred<{
      path: string
      name: string
      content: string
      truncated: boolean
      size: number
      modifiedAt: null
    }>()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'README.md',
          path: '/workspace/project/README.md',
          isDirectory: false,
          size: 12,
          modifiedAt: null,
        },
        {
          name: 'NOTES.md',
          path: '/workspace/project/NOTES.md',
          isDirectory: false,
          size: 11,
          modifiedAt: null,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn((_deviceId: string, path: string) =>
      path.endsWith('README.md') ? readmeFile.promise : notesFile.promise
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(screen.getByTestId('right-workspace-file-option'))
    await user.click(await screen.findByText('README.md'))
    await user.click(screen.getByText('NOTES.md'))

    await act(async () => {
      notesFile.resolve({
        path: '/workspace/project/NOTES.md',
        name: 'NOTES.md',
        content: 'notes first',
        truncated: false,
        size: 11,
        modifiedAt: null,
      })
    })
    expect(await screen.findByTestId('workspace-file-preview-code-view')).toBeInTheDocument()
    await waitFor(() => expect(getWorkspaceCodeViewText()).toContain('notes first'))

    await act(async () => {
      readmeFile.resolve({
        path: '/workspace/project/README.md',
        name: 'README.md',
        content: 'readme stale',
        truncated: false,
        size: 12,
        modifiedAt: null,
      })
    })

    expect(getWorkspaceCodeViewText()).toContain('notes first')
    expect(getWorkspaceCodeViewText()).not.toContain('readme stale')
  })

  test('right workspace panel ignores stale directory responses', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    const srcTree = createDeferred<{
      path: string
      entries: Array<{
        name: string
        path: string
        isDirectory: boolean
        size: number
        modifiedAt: null
      }>
    }>()
    const docsTree = createDeferred<{
      path: string
      entries: Array<{
        name: string
        path: string
        isDirectory: boolean
        size: number
        modifiedAt: null
      }>
    }>()
    const listWorkspaceEntries = vi.fn((_deviceId: string, path: string) => {
      if (path === '/workspace/project/src') return srcTree.promise
      if (path === '/workspace/project/docs') return docsTree.promise
      return Promise.resolve({
        path: '/workspace/project',
        entries: [
          {
            name: 'src',
            path: '/workspace/project/src',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
          {
            name: 'docs',
            path: '/workspace/project/docs',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
        ],
      })
    })
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          ...baseProps.workspaceFileApi,
          listWorkspaceEntries,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    const srcButton = (await screen.findByText('src')).closest('button')
    const docsButton = screen.getByText('docs').closest('button')
    expect(srcButton).not.toBeNull()
    expect(docsButton).not.toBeNull()
    fireEvent.click(srcButton as HTMLButtonElement)
    fireEvent.click(docsButton as HTMLButtonElement)

    await act(async () => {
      docsTree.resolve({
        path: '/workspace/project/docs',
        entries: [
          {
            name: 'guide.md',
            path: '/workspace/project/docs/guide.md',
            isDirectory: false,
            size: 10,
            modifiedAt: null,
          },
        ],
      })
    })
    expect(await screen.findByText('guide.md')).toBeInTheDocument()

    await act(async () => {
      srcTree.resolve({
        path: '/workspace/project/src',
        entries: [
          {
            name: 'main.ts',
            path: '/workspace/project/src/main.ts',
            isDirectory: false,
            size: 10,
            modifiedAt: null,
          },
        ],
      })
    })

    expect(screen.getByText('docs').closest('[data-testid="workspace-directory-row"]')).toHaveClass(
      'ring-1',
      'ring-primary'
    )
    expect(screen.getByText('guide.md')).toBeInTheDocument()
    expect(screen.getByText('main.ts')).toBeInTheDocument()
  })

  test('right workspace panel retries the failed directory path', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    let srcAttempts = 0
    const listWorkspaceEntries = vi.fn((_deviceId: string, path: string) => {
      if (path === '/workspace/project/src') {
        srcAttempts += 1
        if (srcAttempts === 1) {
          return Promise.reject(new Error('src failed'))
        }
        return Promise.resolve({
          path: '/workspace/project/src',
          entries: [
            {
              name: 'main.ts',
              path: '/workspace/project/src/main.ts',
              isDirectory: false,
              size: 12,
              modifiedAt: null,
            },
          ],
        })
      }
      return Promise.resolve({
        path: '/workspace/project',
        entries: [
          {
            name: 'src',
            path: '/workspace/project/src',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
        ],
      })
    })
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          ...baseProps.workspaceFileApi,
          listWorkspaceEntries,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(screen.getByTestId('right-workspace-file-option'))
    await user.click(await screen.findByText('src'))
    expect(await screen.findByText('src failed')).toBeInTheDocument()

    await user.click(screen.getByTestId('workspace-file-tree-retry-button'))

    expect(await screen.findByText('main.ts')).toBeInTheDocument()
    expect(listWorkspaceEntries).toHaveBeenLastCalledWith(
      'workspace-cloud-device',
      '/workspace/project/src'
    )
  })

  test('right workspace panel keeps the same tree for unrelated message updates', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [],
    })
    const layoutProps = {
      ...baseProps,
      workspaceFileApi: {
        ...baseProps.workspaceFileApi,
        listWorkspaceEntries,
      },
      state: {
        ...baseProps.state,
        ...workspacePanelState,
      },
      projectWork: {
        ...baseProps.projectWork,
        projects: workspacePanelState.projects,
        devices: workspacePanelState.devices,
        currentProjectId: workspacePanelState.currentProject?.id,
      },
    }

    const { rerender } = render(<DesktopWorkbenchLayout {...layoutProps} />)

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    await waitFor(() => expect(listWorkspaceEntries).toHaveBeenCalledTimes(1))

    rerender(
      <DesktopWorkbenchLayout
        {...layoutProps}
        messages={[
          {
            id: 'message-update',
            role: 'assistant',
            content: 'streaming content changed',
            status: 'streaming',
            createdAt: '2026-06-12T00:00:00.000Z',
          },
        ]}
      />
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listWorkspaceEntries).toHaveBeenCalledTimes(1)
  })

  test('workspace file preview renders file contents with Pierre file viewer', async () => {
    render(
      <WorkspaceFilePreview
        file={{
          path: '/workspace/project/repeat.txt',
          name: 'repeat.txt',
          content: 'repeat\nmiddle\nrepeat',
          truncated: false,
          size: 20,
          modifiedAt: null,
        }}
        loading={false}
        onRetry={vi.fn()}
        onAddCodeComment={vi.fn()}
      />
    )

    expect(screen.getByTestId('workspace-file-preview-code-view')).toBeInTheDocument()
    expect(
      screen.getByTestId('workspace-file-preview-code-view').querySelector('div')
    ).toBeInTheDocument()
    await waitFor(() => expect(getWorkspaceCodeViewText()).toContain('repeat'))
  })

  test('workspace file preview swaps Pierre viewer when file changes', async () => {
    const firstFile = {
      path: '/workspace/project/first.txt',
      name: 'first.txt',
      content: 'first file',
      truncated: false,
      size: 10,
      modifiedAt: null,
    }
    const secondFile = {
      path: '/workspace/project/second.txt',
      name: 'second.txt',
      content: 'second file',
      truncated: false,
      size: 11,
      modifiedAt: null,
    }
    const { rerender } = render(
      <WorkspaceFilePreview
        file={firstFile}
        loading={false}
        onRetry={vi.fn()}
        onAddCodeComment={vi.fn()}
      />
    )

    await waitFor(() => expect(getWorkspaceCodeViewText()).toContain('first file'))

    rerender(
      <WorkspaceFilePreview
        file={secondFile}
        loading={false}
        onRetry={vi.fn()}
        onAddCodeComment={vi.fn()}
      />
    )

    await waitFor(() => expect(getWorkspaceCodeViewText()).toContain('second file'))
    expect(screen.queryByTestId('workspace-file-comment-input')).not.toBeInTheDocument()
  })

  test('opens the environment info popover and closes it from outside click', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'e13e1a10-5377-4a87-a3b3-634a098d0bb4',
              name: 'yunpeng7-executor-0bb4',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
            },
          ],
        }}
        onLoadEnvironmentInfo={vi.fn().mockResolvedValue({
          additions: '+173',
          deletions: '-13366',
          executionTarget: 'cloud',
          deviceId: 'e13e1a10-5377-4a87-a3b3-634a098d0bb4',
          workspacePath: '/workspace/projects/github_wegent',
          branchName: 'human/narwhal-20260528-073440',
          createPullRequestUrl:
            'https://github.com/wecode-ai/Wegent/compare/human%2Fnarwhal-20260528-073440?expand=1',
        })}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))

    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
    expect(screen.getByTestId('environment-info-popover')).toHaveClass(
      'w-[340px]',
      'bg-background',
      'text-text-primary',
      'border-border',
      'backdrop-blur-3xl',
      'backdrop-saturate-150'
    )
    expect(screen.getByText('环境信息')).toBeInTheDocument()
    expect(screen.getByText('变更')).toBeInTheDocument()
    const deviceSection = screen.getByTestId('environment-device-section')
    const gitSection = screen.getByTestId('environment-git-section')
    expect(deviceSection).not.toContainElement(gitSection)
    expect(gitSection).not.toContainElement(deviceSection)
    const executionTargetRow = screen.getByTestId('environment-execution-target-row')
    expect(deviceSection).toContainElement(executionTargetRow)
    expect(executionTargetRow).toHaveTextContent('位置')
    expect(executionTargetRow).toHaveTextContent('云设备')
    const deviceButton = await screen.findByTestId('environment-device-button')
    expect(deviceSection).toContainElement(deviceButton)
    expect(deviceButton).toHaveTextContent('设备')
    expect(deviceButton).toHaveTextContent('yunpeng7-executor-0bb4')
    expect(deviceButton).not.toHaveTextContent('云设备')
    expect(deviceButton).not.toHaveTextContent('e13e1a10')
    expect(deviceButton).not.toHaveTextContent('8ef4')
    expect(screen.queryByTestId('environment-device-id')).not.toBeInTheDocument()
    expect(deviceButton).toHaveAttribute('title', '设备 · yunpeng7-executor-0bb4')
    const workspacePathButton = screen.getByTestId('environment-workspace-path-button')
    expect(deviceSection).toContainElement(workspacePathButton)
    expect(workspacePathButton).toHaveTextContent('/workspace/projects/github_wegent')
    expect(workspacePathButton).toContainElement(
      screen.getByTestId('environment-workspace-path-copy-icon')
    )
    expect(gitSection).toHaveTextContent('变更')
    expect(await screen.findByText('+173')).toBeInTheDocument()
    expect(await screen.findByText('-13366')).toBeInTheDocument()
    expect(gitSection).toHaveTextContent('human/narwhal-20260528-073440')
    expect(gitSection).toHaveTextContent('提交')
    expect(gitSection).toHaveTextContent('创建拉取请求')
    expect(gitSection).toHaveTextContent('来源')
    expect(gitSection).toHaveTextContent('暂无来源')

    await userEvent.click(deviceButton)

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()

    await userEvent.click(workspacePathButton)

    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      '/workspace/projects/github_wegent'
    )

    await userEvent.click(document.body)

    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()
  })

  test('opens environment changes review in the right workspace panel', async () => {
    const onLoadEnvironmentDiff = vi
      .fn()
      .mockResolvedValue(
        'diff --git a/src/env.ts b/src/env.ts\n--- a/src/env.ts\n+++ b/src/env.ts\n@@ -1 +1 @@\n-old\n+new\n'
      )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentDiff={onLoadEnvironmentDiff}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            tasks: [],
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'device-1',
              },
              workspace: {
                source: 'local_path',
                localPath: '/workspace/github_wegent',
              },
            },
          },
        }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(await screen.findByTestId('environment-changes-button'))

    await waitFor(() =>
      expect(onLoadEnvironmentDiff).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, name: 'github_wegent' }),
        {
          deviceId: 'device-1',
          path: '/workspace/github_wegent',
          source: 'project',
        },
        'branch'
      )
    )
    expect(screen.queryByRole('dialog', { name: '本轮文件变更' })).not.toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-review-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(await screen.findByTestId('file-changes-review-panel')).toHaveTextContent('src/env.ts')
    expect(screen.getByTestId('file-changes-review-panel')).toHaveTextContent('new')
  })

  test('submits environment commits from the popover', async () => {
    const onCommitEnvironmentChanges = vi.fn().mockResolvedValue(undefined)
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onCommitEnvironmentChanges={onCommitEnvironmentChanges}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            tasks: [],
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'device-1',
              },
              workspace: {
                source: 'local_path',
                localPath: '/workspace/github_wegent',
              },
            },
          },
        }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(await screen.findByTestId('environment-commit-button'))
    await userEvent.type(screen.getByTestId('environment-commit-message-input'), 'feat: ship')
    await userEvent.click(screen.getByTestId('environment-confirm-commit-button'))

    await waitFor(() =>
      expect(onCommitEnvironmentChanges).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, name: 'github_wegent' }),
        'feat: ship',
        {
          deviceId: 'device-1',
          path: '/workspace/github_wegent',
          source: 'project',
        }
      )
    )
    expect(screen.getByText('已提交')).toBeInTheDocument()
  })

  test('switches and creates branches from the environment popover', async () => {
    const onListEnvironmentBranches = vi
      .fn()
      .mockResolvedValue(['main', 'human/chipmunk-20260603-053420', 'human/alpaca-20260603-050330'])
    const onCheckoutEnvironmentBranch = vi.fn().mockResolvedValue(undefined)
    const onCreateEnvironmentBranch = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onListEnvironmentBranches={onListEnvironmentBranches}
        onCheckoutEnvironmentBranch={onCheckoutEnvironmentBranch}
        onCreateEnvironmentBranch={onCreateEnvironmentBranch}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            tasks: [],
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'device-1',
              },
              workspace: {
                source: 'local_path',
                localPath: '/workspace/github_wegent',
              },
            },
          },
        }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(await screen.findByTestId('environment-branch-row'))

    expect(await screen.findByTestId('environment-branch-menu')).toBeInTheDocument()
    await waitFor(() => expect(onListEnvironmentBranches).toHaveBeenCalledTimes(1))
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('human/chipmunk-20260603-053420')).toBeInTheDocument()

    await userEvent.type(screen.getByTestId('environment-branch-search-input'), 'alp')
    expect(screen.getByText('human/alpaca-20260603-050330')).toBeInTheDocument()
    expect(screen.queryByText('human/chipmunk-20260603-053420')).not.toBeInTheDocument()

    await userEvent.click(screen.getByText('human/alpaca-20260603-050330'))
    await waitFor(() =>
      expect(onCheckoutEnvironmentBranch).toHaveBeenCalledWith(
        expect.anything(),
        'human/alpaca-20260603-050330',
        {
          deviceId: 'device-1',
          path: '/workspace/github_wegent',
          source: 'project',
        }
      )
    )

    await userEvent.click(await screen.findByTestId('environment-branch-row'))
    await userEvent.click(await screen.findByTestId('environment-open-new-branch-button'))
    await userEvent.type(screen.getByTestId('environment-new-branch-input'), 'human/new-branch')
    await userEvent.click(screen.getByTestId('environment-confirm-new-branch-button'))

    await waitFor(() =>
      expect(onCreateEnvironmentBranch).toHaveBeenCalledWith(
        expect.anything(),
        'human/new-branch',
        {
          deviceId: 'device-1',
          path: '/workspace/github_wegent',
          source: 'project',
        }
      )
    )
  })

  test('does not reopen the branch menu when the environment popover is reopened', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(screen.getByTestId('environment-branch-row'))

    expect(await screen.findByTestId('environment-branch-menu')).toBeInTheDocument()

    await userEvent.click(document.body)
    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('environment-info-button'))

    expect(await screen.findByTestId('environment-info-popover')).toBeInTheDocument()
    expect(screen.queryByTestId('environment-branch-menu')).not.toBeInTheDocument()
  })

  test('keeps environment diff stats and branch row visible without a current branch', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={vi.fn().mockResolvedValue({
          additions: '+55',
          deletions: '-8',
          executionTarget: 'local',
          deviceId: 'device-1',
          workspacePath: '/workspace/plain-folder',
          branchName: '',
        })}
        onListEnvironmentBranches={vi.fn().mockResolvedValue([])}
        onCheckoutEnvironmentBranch={vi.fn().mockResolvedValue(undefined)}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))

    await waitFor(() => expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument())
    expect(screen.getByTestId('environment-workspace-path')).toHaveTextContent(
      '/workspace/plain-folder'
    )
    const gitSection = screen.getByTestId('environment-git-section')
    expect(gitSection).toHaveTextContent('变更')
    expect(gitSection).toHaveTextContent('+55')
    expect(gitSection).toHaveTextContent('-8')
    expect(screen.getByTestId('environment-branch-row')).toHaveTextContent('暂无分支')
    expect(screen.queryByTestId('environment-commit-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('create-pull-request-button')).not.toBeInTheDocument()
  })

  test('closes the branch menu when Escape is pressed', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(screen.getByTestId('environment-branch-row'))

    expect(await screen.findByTestId('environment-branch-menu')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByTestId('environment-branch-menu')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
  })

  test('loads environment info from the first workspace project when the popover opens', async () => {
    const onLoadEnvironmentInfo = vi.fn().mockResolvedValue({
      additions: '+8',
      deletions: '-3',
      executionTarget: 'local' as const,
      deviceId: 'device-from-fallback',
      branchName: 'feature/fallback',
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: null,
          projects: [
            { id: 1, name: 'legacy', tasks: [] },
            {
              id: 2,
              name: 'workspace',
              tasks: [],
              config: {
                mode: 'workspace',
                execution: {
                  targetType: 'local',
                  deviceId: 'device-from-fallback',
                },
                workspace: {
                  source: 'local_path',
                  localPath: '/repo',
                },
              },
            },
          ],
        }}
      />
    )

    expect(onLoadEnvironmentInfo).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('environment-info-button'))

    await waitFor(() =>
      expect(onLoadEnvironmentInfo).toHaveBeenCalledWith(
        expect.objectContaining({ id: 2, name: 'workspace' }),
        {
          deviceId: 'device-from-fallback',
          path: '/repo',
          source: 'project',
        }
      )
    )
  })

  test('loads environment info automatically from the current runtime task workspace', async () => {
    const onLoadEnvironmentInfo = vi.fn().mockResolvedValue({
      additions: '+2',
      deletions: '-0',
      executionTarget: 'local' as const,
      deviceId: 'runtime-device',
      branchName: 'runtime/worktree',
    })
    const onGetProjectWorkspaceRoot = vi.fn().mockResolvedValue('/workspace/projects')
    const runtimeProject = {
      id: 12,
      name: 'runtime-project',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: 'runtime-device',
        },
      },
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: null,
          currentRuntimeTask: {
            deviceId: 'runtime-device',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-1',
          },
          projects: [
            {
              id: 2,
              name: 'fallback',
              tasks: [],
              config: {
                mode: 'workspace',
                execution: {
                  targetType: 'local',
                  deviceId: 'fallback-device',
                },
                workspace: {
                  source: 'local_path',
                  localPath: '/workspace/fallback',
                },
              },
            },
            runtimeProject,
          ],
          runtimeWork: {
            projects: [
              {
                project: { id: runtimeProject.id, name: runtimeProject.name },
                deviceWorkspaces: [
                  {
                    id: 91,
                    deviceId: 'runtime-device',
                    workspacePath: '/workspace/project-alpha',
                    available: true,
                    mapped: true,
                    tasks: [
                      {
                        taskId: 'runtime-1',
                        workspacePath: '/workspace/worktrees/8/project-alpha',
                        title: 'Runtime task',
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
      />
    )

    await waitFor(() =>
      expect(onLoadEnvironmentInfo).toHaveBeenCalledWith(runtimeProject, {
        deviceId: 'runtime-device',
        path: '/workspace/worktrees/8/project-alpha',
        source: 'runtime',
      })
    )
    expect(onGetProjectWorkspaceRoot).not.toHaveBeenCalled()
  })

  test('loads environment info automatically for the current project workspace', async () => {
    const onLoadEnvironmentInfo = vi.fn().mockResolvedValue({
      additions: '+4',
      deletions: '-1',
      executionTarget: 'local' as const,
      deviceId: 'device-1',
      branchName: 'feature/done',
    })
    const workspaceProject = {
      id: 1,
      name: 'workspace',
      tasks: [],
      config: {
        mode: 'workspace',
        execution: {
          targetType: 'local' as const,
          deviceId: 'device-1',
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/repo',
        },
      },
    }
    const streamingMessage = {
      id: 'assistant-1',
      role: 'assistant' as const,
      content: 'Working',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: workspaceProject,
        }}
        messages={[streamingMessage]}
      />
    )

    await waitFor(() => {
      expect(onLoadEnvironmentInfo).toHaveBeenCalledTimes(1)
      expect(onLoadEnvironmentInfo).toHaveBeenCalledWith(workspaceProject, {
        deviceId: 'device-1',
        path: '/repo',
        source: 'project',
      })
    })

    rerender(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: workspaceProject,
        }}
        messages={[
          {
            ...streamingMessage,
            status: 'done' as const,
          },
        ]}
      />
    )

    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(onLoadEnvironmentInfo).toHaveBeenCalledTimes(1)
  })

  test('does not reload environment info when runtime work polling keeps the same project workspace target', async () => {
    const onLoadEnvironmentInfo = vi.fn().mockResolvedValue({
      additions: '+4',
      deletions: '-1',
      executionTarget: 'local' as const,
      deviceId: 'device-1',
      branchName: 'feature/done',
    })
    const workspaceProject = {
      id: 1,
      name: 'workspace',
      tasks: [],
      config: {
        mode: 'workspace',
        execution: {
          targetType: 'local' as const,
          deviceId: 'device-1',
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/repo',
        },
      },
    }
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: 'project:1', id: 1, name: 'workspace' },
          deviceWorkspaces: [
            {
              id: 1,
              projectId: 1,
              deviceId: 'device-1',
              available: true,
              mapped: true,
              workspacePath: '/repo',
              tasks: [],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 0,
    }
    const { rerender } = render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: workspaceProject,
          runtimeWork,
        }}
      />
    )

    await waitFor(() => {
      expect(onLoadEnvironmentInfo).toHaveBeenCalledTimes(1)
      expect(onLoadEnvironmentInfo).toHaveBeenCalledWith(workspaceProject, {
        deviceId: 'device-1',
        path: '/repo',
        source: 'project',
      })
    })

    rerender(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: workspaceProject,
          runtimeWork: structuredClone(runtimeWork),
        }}
      />
    )

    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(onLoadEnvironmentInfo).toHaveBeenCalledTimes(1)
  })

  test('closes the right workspace panel from the panel actions', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    const floatingActions = screen.getByTestId('workspace-panel-floating-actions')
    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument()
    expect(floatingActions).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(screen.queryByTestId('right-workspace-panel')).not.toBeInTheDocument()
    expect(floatingActions).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
  })

  test('opens and resizes the bottom workspace panel', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    const panel = screen.getByTestId('bottom-workspace-panel')
    expect(panel).toBeInTheDocument()
    expect(panel).toHaveClass(
      'transition-[height,opacity,transform]',
      'duration-300',
      'ease-out',
      'pointer-events-auto',
      'translate-y-0',
      'opacity-100'
    )
    expect(panel).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByTestId('desktop-workbench-content')).not.toContainElement(panel)
    expect(screen.getByTestId('desktop-workbench-main')).toContainElement(panel)
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByTestId('bottom-workspace-resize-handle'), { clientY: 700 })
    fireEvent.pointerMove(document, { clientY: 620 })
    fireEvent.pointerUp(document)

    expect(panel).toHaveStyle({ height: '400px' })
  })

  test('opens the terminal by default when the bottom workspace panel opens', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    await waitFor(() => expect(startTerminalSessionMock).toHaveBeenCalledWith(12))
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')
    expect(screen.queryByTestId('workspace-terminal-frame')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-terminal-window')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-tool-launcher')).not.toBeInTheDocument()
  })

  test('opens a local project terminal when a project is selected without an active task', async () => {
    const otherWorkspaceProject = {
      id: 31,
      name: 'ws1',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/Users/me/ws1',
        },
      },
    }
    const localWorkspaceProject = {
      id: 32,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/Users/me/Wegent',
        },
      },
    }
    isLocalTerminalAvailableMock.mockReturnValue(true)
    localPathExistsMock.mockResolvedValue(true)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: null,
          projects: [otherWorkspaceProject, localWorkspaceProject],
          devices: [],
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: [otherWorkspaceProject, localWorkspaceProject],
          currentProjectId: localWorkspaceProject.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/Users/me/Wegent',
      })
    )
    expect(startTerminalSessionMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('embedded-local-terminal')).toHaveAttribute(
      'data-session-id',
      'local-terminal-1'
    )
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('uses local mode for a selected git project without an active task', async () => {
    const gitWorkspaceProject = {
      id: 33,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'cloud' as const,
          deviceId: 'workspace-cloud-device',
        },
        workspace: {
          source: 'git' as const,
          checkoutPath: '/Users/me/Wegent',
        },
      },
    }
    isLocalTerminalAvailableMock.mockReturnValue(true)
    getLocalExecutorDeviceIdMock.mockResolvedValue(null)
    localPathExistsMock.mockResolvedValue(true)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: null,
          projects: [gitWorkspaceProject],
          devices: [],
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: [gitWorkspaceProject],
          currentProjectId: gitWorkspaceProject.id,
          executionMode: 'current_workspace',
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/Users/me/Wegent',
      })
    )
    expect(startTerminalSessionMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('embedded-local-terminal')).toHaveAttribute(
      'data-session-id',
      'local-terminal-1'
    )
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('opens the selected runtime project workspace path instead of the home directory', async () => {
    const runtimeProject = {
      id: 34,
      name: 'Wegent',
      tasks: [],
    }
    const localDevice = {
      id: 41,
      device_id: 'local-device',
      name: 'Mac',
      status: 'online' as const,
      is_default: false,
      device_type: 'local' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
    isLocalTerminalAvailableMock.mockReturnValue(true)
    getLocalExecutorDeviceIdMock.mockResolvedValue('local-device')
    localPathExistsMock.mockResolvedValue(true)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: runtimeProject,
          projects: [],
          devices: [localDevice],
          runtimeWork: {
            projects: [
              {
                project: {
                  id: runtimeProject.id,
                  key: 'project:wegent',
                  name: runtimeProject.name,
                },
                deviceWorkspaces: [
                  {
                    id: 42,
                    deviceId: localDevice.device_id,
                    deviceStatus: 'online',
                    available: true,
                    workspacePath: '/Users/me/Wegent',
                    workspaceSource: 'local',
                    tasks: [],
                  },
                ],
              },
            ],
            chats: [],
            totalTasks: 0,
          },
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: [],
          devices: [localDevice],
          runtimeWork: {
            projects: [
              {
                project: {
                  id: runtimeProject.id,
                  key: 'project:wegent',
                  name: runtimeProject.name,
                },
                deviceWorkspaces: [
                  {
                    id: 42,
                    deviceId: localDevice.device_id,
                    deviceStatus: 'online',
                    available: true,
                    workspacePath: '/Users/me/Wegent',
                    workspaceSource: 'local',
                    tasks: [],
                  },
                ],
              },
            ],
            chats: [],
            totalTasks: 0,
          },
          currentProject: runtimeProject,
          currentProjectId: runtimeProject.id,
          selectedDeviceWorkspaceId: 42,
          executionMode: 'current_workspace',
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/Users/me/Wegent',
      })
    )
    expect(startTerminalSessionMock).not.toHaveBeenCalled()
    expect(localPathExistsMock).toHaveBeenCalledWith('/Users/me/Wegent')
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('preserves bottom terminal state per runtime task', async () => {
    const { localDevice, propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()
    isLocalTerminalAvailableMock.mockReturnValue(true)
    getLocalExecutorDeviceIdMock.mockResolvedValue(localDevice.device_id)
    localPathExistsMock.mockResolvedValue(true)
    startLocalTerminalMock
      .mockResolvedValueOnce('local-terminal-a')
      .mockResolvedValueOnce('local-terminal-b')
    const visibleLocalTerminals = () =>
      within(screen.getByTestId('desktop-workbench-main'))
        .queryAllByTestId('embedded-local-terminal')
        .filter(element => !element.hasAttribute('hidden'))

    const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/Users/me/Wegent/.worktrees/a',
      })
    )
    await waitFor(() => {
      const terminals = visibleLocalTerminals()
      expect(terminals).toHaveLength(1)
      expect(terminals[0]).toHaveAttribute('data-session-id', 'local-terminal-a')
    })

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)

    expect(visibleLocalTerminals()).toHaveLength(0)
    expect(startLocalTerminalMock).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/Users/me/Wegent/.worktrees/b',
      })
    )
    await waitFor(() => {
      const terminals = visibleLocalTerminals()
      expect(terminals).toHaveLength(1)
      expect(terminals[0]).toHaveAttribute('data-session-id', 'local-terminal-b')
    })

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    expect(startLocalTerminalMock).toHaveBeenCalledTimes(2)
    await waitFor(() => {
      const terminals = visibleLocalTerminals()
      expect(terminals).toHaveLength(1)
      expect(terminals[0]).toHaveAttribute('data-session-id', 'local-terminal-a')
    })
  })

  test('keeps runtime task terminals past the pane cache limit until the task is archived', async () => {
    const { localDevice, propsForTask, runtimeWork, taskA, taskAddresses } =
      createLocalRuntimeTaskPanelFixture()
    isLocalTerminalAvailableMock.mockReturnValue(true)
    getLocalExecutorDeviceIdMock.mockResolvedValue(localDevice.device_id)
    localPathExistsMock.mockResolvedValue(true)
    taskAddresses.forEach(task => {
      const suffix = task.taskId.replace('runtime-', '')
      startLocalTerminalMock.mockResolvedValueOnce(`local-terminal-${suffix}`)
    })
    const visibleLocalTerminals = () =>
      within(screen.getByTestId('desktop-workbench-main'))
        .queryAllByTestId('embedded-local-terminal')
        .filter(element => !element.hasAttribute('hidden'))

    const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    for (const [index, task] of taskAddresses.entries()) {
      if (index > 0) {
        rerender(<DesktopWorkbenchLayout {...propsForTask(task)} />)
      }
      const suffix = task.taskId.replace('runtime-', '')
      await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))
      await waitFor(() => {
        const terminals = visibleLocalTerminals()
        expect(terminals).toHaveLength(1)
        expect(terminals[0]).toHaveAttribute('data-session-id', `local-terminal-${suffix}`)
      })
    }

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    expect(startLocalTerminalMock).toHaveBeenCalledTimes(taskAddresses.length)
    expect(closeLocalTerminalMock).not.toHaveBeenCalledWith('local-terminal-a')
    await waitFor(() => {
      const terminals = visibleLocalTerminals()
      expect(terminals).toHaveLength(1)
      expect(terminals[0]).toHaveAttribute('data-session-id', 'local-terminal-a')
    })

    const archivedTaskAWork = {
      projects: [
        {
          ...runtimeWork.projects[0],
          deviceWorkspaces: [
            {
              ...runtimeWork.projects[0].deviceWorkspaces[0],
              tasks: runtimeWork.projects[0].deviceWorkspaces[0].tasks.filter(
                task => task.taskId !== taskA.taskId
              ),
            },
          ],
        },
      ],
      chats: [],
      totalTasks: taskAddresses.length - 1,
    }
    rerender(
      <DesktopWorkbenchLayout
        {...propsForTask(taskAddresses[1], { runtimeWork: archivedTaskAWork })}
      />
    )

    await waitFor(() => {
      expect(closeLocalTerminalMock).toHaveBeenCalledWith('local-terminal-a')
    })
  })

  test('opens the bottom workspace add menu without replacing the terminal', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))
    await waitFor(() => expect(startTerminalSessionMock).toHaveBeenCalledWith(12))

    expect(screen.getByTestId('bottom-workspace-panel')).not.toHaveClass('rounded-t-xl')
    expect(screen.getByTestId('bottom-workspace-tabbar')).toHaveClass('bg-background')
    expect(screen.getByTestId('bottom-workspace-tabbar')).not.toHaveClass('border-b')
    const initialTab = screen.getByTestId('bottom-workspace-terminal-tab')
    expect(initialTab).toHaveClass('bg-muted', 'text-text-primary')
    expect(initialTab).not.toHaveClass('border', 'border-border', 'shadow-sm')
    expect(initialTab).not.toHaveTextContent('终端')
    await waitFor(() => expect(initialTab).toHaveTextContent('project'))
    expect(initialTab).toHaveAttribute('title', 'project')
    expect(initialTab).toHaveClass('max-w-[200px]', 'pr-7')
    expect(initialTab).not.toHaveClass('hover:max-w-none')
    const initialCloseButton = within(initialTab).getByTestId('close-bottom-workspace-tab-button')
    expect(initialCloseButton).toHaveClass(
      'group-hover:bg-border/70',
      'hover:!bg-text-secondary',
      'hover:text-background'
    )
    expect(initialCloseButton).not.toHaveClass('hover:bg-black/70', 'hover:text-white')

    await userEvent.click(screen.getByTestId('workspace-terminal-new-tab-button'))

    const menu = screen.getByTestId('workspace-terminal-new-tab-menu')
    expect(menu).toBeInTheDocument()
    expect(screen.getByTestId('workspace-terminal-window')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-tool-launcher')).not.toBeInTheDocument()
    expect(within(menu).getByTestId('workspace-add-terminal-option')).toHaveTextContent('终端')
    expect(within(menu).queryByTestId('workspace-add-review-option')).not.toBeInTheDocument()
    expect(within(menu).queryByTestId('workspace-add-browser-option')).not.toBeInTheDocument()
    expect(within(menu).queryByTestId('workspace-add-files-option')).not.toBeInTheDocument()

    await userEvent.click(within(menu).getByTestId('workspace-add-terminal-option'))

    expect(screen.queryByTestId('workspace-terminal-new-tab-menu')).not.toBeInTheDocument()
    await waitFor(() => expect(startTerminalSessionMock).toHaveBeenCalledTimes(2))
    expect(screen.getAllByTestId('remote-terminal')).toHaveLength(2)
    expect(screen.getAllByTestId('bottom-workspace-terminal-tab')).toHaveLength(2)
    expect(screen.getAllByTestId('bottom-workspace-terminal-tab')[1]).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('right-workspace-panel-shell')).toHaveAttribute('aria-hidden', 'true')
  })

  test('closes the bottom workspace panel from the panel edge', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))
    const panel = screen.getByTestId('bottom-workspace-panel')
    expect(panel).toBeInTheDocument()
    expect(panel).toHaveClass('opacity-100')

    await userEvent.click(screen.getByTestId('close-bottom-workspace-panel-button'))

    expect(panel).toBeInTheDocument()
    expect(panel).toHaveStyle({ height: '0px' })
    expect(panel).toHaveClass('pointer-events-none', 'translate-y-3', 'opacity-0')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
  })
})
