import { createDeviceApi } from '@/api/devices'
import { getLocalCodexUsageDisplay } from '@/api/local/codexUsage'
import { createProjectApi } from '@/api/projects'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import {
  TITLEBAR_ACTIONS_PORTAL_ID,
  TITLEBAR_FEEDBACK_PORTAL_ID,
  TITLEBAR_RIGHT_PANEL_PORTAL_ID,
} from '@/components/topnav/TitlebarActionsPortal'
import { AppearanceProvider } from '@/features/appearance'
import { AuthContext } from '@/features/auth/useAuth'
import { queueSmartAppDevelopmentPreview } from '@/features/harness-apps/smartAppDevelopmentPreview'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
} from '@/features/workbench/runtimeConversationCache'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import {
  EMPTY_RUNTIME_TASK_REMINDERS,
  type RuntimeTaskReminderState,
} from '@/features/workbench/runtimeTaskReminders'
import {
  resolveTemporaryChatActiveModel,
  resolveTemporaryChatModelSelection,
} from '@/features/workbench/temporaryChatModelContext'
import { WorkbenchContext, WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type {
  WorkbenchContextValue,
  WorkbenchPaneContextValue,
} from '@/features/workbench/workbenchContextTypes'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { dispatchWorkspaceTabsClosed } from '@/features/workspace-tabs/workspaceTabs'
import {
  WorkspaceTabsContext,
  type WorkspaceTabsContextValue,
} from '@/features/workspace-tabs/workspaceTabsContextValue'
import '@/i18n'
import { requestEmbeddedBrowserOpen } from '@/lib/embedded-browser'
import { openExternalUrl } from '@/lib/external-links'
import { setActiveKeybindings } from '@/lib/keybindings'
import { qualifyLocalRuntimeSource } from '@/lib/local-runtime-sidebar-identity'
import {
  archiveLocalHarnessSession,
  closeLocalTerminal,
  getLocalExecutorDeviceId,
  getLocalPathKind,
  isLocalHarnessAvailable,
  isLocalTerminalAvailable,
  listLocalHarnesses,
  listLocalHarnessSessions,
  localPathExists,
  openLocalWorkspace,
  startLocalHarness,
  startLocalTerminal,
} from '@/lib/local-terminal'
import { navigateTo, WORKSPACE_NAVIGATION_EVENT } from '@/lib/navigation'
import { configuredWorkspacePath, executionDeviceId } from '@/lib/project-workspace'
import {
  consumeNewChatComposerRequest,
  requestNewChatComposerFocus,
} from '@/lib/workbenchComposerFocus'
import { PopoutWorkbenchPage } from '@/pages/PopoutWorkbenchPage'
import { preloadDefaultDshUiTestModules } from '@/test/setup.dom'
import type { ProjectWithTasks, RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import type {
  RuntimePaneTranscript,
  RuntimeSubagentStatus,
  WorkbenchMessage,
} from '@/types/workbench'
import type { WorkspaceFileApi } from '@/types/workspace-files'
import {
  getWorkspaceCodeText,
  installPierreEditorTestPlatform,
  replaceWorkspaceEditorText,
} from '@/test/pierreCode'
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { useEffect, useMemo } from 'react'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { installGitUiTestContributions } from '../../../dsh/ui-git/test-support'
import { DesktopWorkbenchLayout as ActualDesktopWorkbenchLayout } from './DesktopWorkbenchLayout'
import { workbenchSplitStorageKeys } from './useWorkbenchSplitGroups'
import { requestProjectCreateMode } from './workbenchShellEvents'
import {
  createWorkbenchSplitGroupsState,
  serializeWorkbenchSplitGroups,
} from './workbenchSplitGroups'
import { FileWorkspacePanel } from './workspace-panels/FileWorkspacePanel'
import { WorkspaceFilePreview } from './workspace-panels/WorkspaceFilePreview'

const paneSessionMockRef = vi.hoisted(() => ({
  current: undefined as unknown,
}))
const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))
const runtimeMocks = vi.hoisted(() => ({ electron: false }))
const deviceExecuteCommandMock = vi.hoisted(() => vi.fn())
const deliveryApiMock = vi.hoisted(() => ({
  available: false,
  runtimePortAvailable: false,
  listCloudProjects: vi.fn(),
  listCloudFiles: vi.fn(),
  listLoopItems: vi.fn(),
  listDeliveries: vi.fn(),
  listTaskBindings: vi.fn(),
  findCloudContextForTask: vi.fn(),
  trackProjectTask: vi.fn(),
  findRuntimeContext: vi.fn(),
  findRuntimeIssue: vi.fn(),
}))
const sharedWorkspaceApiMock = {
  workspaces: {
    async list() {
      const response = await deliveryApiMock.listCloudProjects()
      const workspaceIds = [
        ...new Set(
          response.items.flatMap(project =>
            typeof project.workspace_id === 'string' ? [project.workspace_id] : []
          )
        ),
      ]
      return workspaceIds.map(workspaceId => ({
        id: workspaceId,
        name: 'Test Workspace',
        description: '',
        owner_user_id: 1,
        current_user_role: 'Owner',
        member_count: 1,
        agent_count: 0,
        execution_environment_count: 0,
        project_count: response.items.filter(project => project.workspace_id === workspaceId)
          .length,
        version: 1,
        created_at: '2026-09-11T00:00:00Z',
        updated_at: '2026-09-11T00:00:00Z',
      }))
    },
    async get(workspaceId: string) {
      const workspaces = await this.list()
      const workspace = workspaces.find(candidate => candidate.id === workspaceId)
      if (!workspace) throw new Error(`Workspace ${workspaceId} was not found`)
      return workspace
    },
    async listMembers() {
      return []
    },
    async listAgents() {
      return []
    },
    async listExecutionEnvironments() {
      return []
    },
  },
  resources: {
    devices: {
      local: async () => [],
      cloud: async () => [],
    },
    async list() {
      return { agents: [], execution_environments: [] }
    },
  },
  projects: {
    async list() {
      const response = await deliveryApiMock.listCloudProjects()
      return response.items.map(project => ({ ...project, id: String(project.id) }))
    },
    async get(projectId: string) {
      const response = await deliveryApiMock.listCloudProjects()
      const project = response.items.find(candidate => String(candidate.id) === projectId)
      if (!project) throw new Error(`Project ${projectId} was not found`)
      return { ...project, id: String(project.id) }
    },
    async listExecutionEnvironments() {
      return []
    },
  },
  issues: {
    async list(projectId: string) {
      const response = await deliveryApiMock.listLoopItems(projectId)
      return response.items.map(item => ({
        ...item,
        id: String(item.id),
        cloud_project_id: String(item.cloud_project_id),
      }))
    },
    async getBoardSnapshot(projectId: string) {
      const response = await deliveryApiMock.listLoopItems(projectId)
      return {
        items: response.items.map(item => ({
          ...item,
          id: String(item.id),
          cloud_project_id: String(item.cloud_project_id),
        })),
        taskBindings: [],
        members: [],
        agents: [],
      }
    },
    async update(_issueId: string, input: Record<string, unknown>) {
      return input
    },
  },
  members: {
    async list() {
      return []
    },
    async searchUsers() {
      return []
    },
    async add() {
      throw new Error('Not implemented in layout test')
    },
    async update() {
      throw new Error('Not implemented in layout test')
    },
    async remove() {},
  },
  agents: {
    async list() {
      return []
    },
    async create() {
      throw new Error('Not implemented in layout test')
    },
    async update() {
      throw new Error('Not implemented in layout test')
    },
  },
  files: {
    async list() {
      return []
    },
    async listDeliveryFiles() {
      return []
    },
    async createFolder() {
      throw new Error('Not implemented in layout test')
    },
    async upload() {
      throw new Error('Not implemented in layout test')
    },
    async access() {
      throw new Error('Not implemented in layout test')
    },
    async read() {
      throw new Error('Not implemented in layout test')
    },
    async move() {
      throw new Error('Not implemented in layout test')
    },
    async remove() {},
    async accessDeliveryFile() {
      throw new Error('Not implemented in layout test')
    },
    async readDeliveryFile() {
      throw new Error('Not implemented in layout test')
    },
  },
  attachments: {
    async list() {
      return []
    },
  },
} as unknown as SharedWorkspaceApi
const embeddedBrowserMocks = vi.hoisted(() => ({
  closeEmbeddedBrowser: vi.fn().mockResolvedValue(undefined),
  setEmbeddedBrowserActiveTab: vi.fn().mockResolvedValue(undefined),
}))
const desktopHostMocks = vi.hoisted(() => {
  const subscribers = new Set<(event: Record<string, unknown>) => void>()
  return {
    emit(event: Record<string, unknown>) {
      subscribers.forEach(handler => handler(event))
    },
    invoke: vi.fn(async (capability: string): Promise<unknown> => {
      if (capability === 'browser.open') {
        return { nativeLabel: 'embedded-browser-native-test', title: null, url: null }
      }
      if (capability === 'window.getState') return { maximized: false }
      return {}
    }),
    subscribe: vi.fn((handler: (event: Record<string, unknown>) => void) => {
      subscribers.add(handler)
      return () => subscribers.delete(handler)
    }),
  }
})
const harnessAppMocks = vi.hoisted(() => ({
  addPlugin: vi.fn(),
  inspectVerification: vi.fn(),
  list: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  verify: vi.fn(),
}))
const harnessAppTabMocks = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
  takeProxyToken: vi.fn(),
  takeContextToken: vi.fn(),
  takeDecisionToken: vi.fn(),
}))
const dshExtensionMocks = vi.hoisted(() => ({
  bindConversationController: vi.fn(() => vi.fn()),
}))
const deviceSurfaceExtensionMock = vi.hoisted(() => {
  const launch = vi.fn()

  return {
    available: false,
    supportsDevice: vi.fn(() => true),
    workspaceMenuItem: vi.fn(() => ({
      id: 'device-surface',
      label: '设备界面',
      icon: () => null,
      testId: 'workspace-add-device-surface-option',
    })),
    DeviceAction: () => null,
    WorkspaceAction: ({
      onLaunchActionChange,
    }: {
      onLaunchActionChange?: (
        action: ((options?: { notifyOpened?: boolean }) => Promise<void>) | null
      ) => void
    }) => {
      useEffect(() => {
        const launchAction = async (options?: { notifyOpened?: boolean }) => {
          await launch(options)
        }
        onLaunchActionChange?.(launchAction)
        return () => onLaunchActionChange?.(null)
      }, [onLaunchActionChange])
      return null
    },
    isInternalPageUrl: vi.fn(() => false),
    launch,
  }
})

vi.mock('@extensions/device-surface', () => ({
  deviceSurfaceExtension: deviceSurfaceExtensionMock,
}))

vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => runtimeMocks.electron,
  isElectronRuntime: () => runtimeMocks.electron,
  getDesktopWindowLabel: () => 'main',
}))

vi.mock('@/lib/embedded-browser', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/embedded-browser')>()
  return {
    ...actual,
    closeEmbeddedBrowser: embeddedBrowserMocks.closeEmbeddedBrowser,
    setEmbeddedBrowserActiveTab: embeddedBrowserMocks.setEmbeddedBrowserActiveTab,
  }
})

vi.mock('@/api/local/harnessApps', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/local/harnessApps')>()
  return {
    ...actual,
    harnessAppsApi: {
      ...actual.harnessAppsApi,
      addPlugin: harnessAppMocks.addPlugin,
      inspectVerification: harnessAppMocks.inspectVerification,
      list: harnessAppMocks.list,
      start: harnessAppMocks.start,
      stop: harnessAppMocks.stop,
      verify: harnessAppMocks.verify,
    },
  }
})

vi.mock('@/features/harness-apps/harnessAppTabs', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/harness-apps/harnessAppTabs')>()
  return {
    ...actual,
    registerHarnessAppTab: harnessAppTabMocks.register,
    unregisterHarnessAppTab: harnessAppTabMocks.unregister,
    takeHarnessAppProxyToken: harnessAppTabMocks.takeProxyToken,
    takeHarnessAppContextToken: harnessAppTabMocks.takeContextToken,
    takeHarnessAppDecisionToken: harnessAppTabMocks.takeDecisionToken,
  }
})

vi.mock('@/features/dsh-runtime/dshExtensions', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/dsh-runtime/dshExtensions')>()
  return {
    ...actual,
    bindDshConversationController: dshExtensionMocks.bindConversationController,
  }
})

vi.mock('./useWorkbenchPaneSession', () => ({
  useWorkbenchPaneSession: () => paneSessionMockRef.current,
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopHostMocks.invoke,
  subscribeDesktopHostEvents: desktopHostMocks.subscribe,
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

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn(),
}))

const nativeDirectoryPickerMocks = vi.hoisted(() => ({
  openNativeProjectDirectoryPicker: vi.fn(),
}))

const automationMocks = vi.hoisted(() => ({
  useNativeDirectoryPicker: true,
}))

vi.mock('@/e2e/automation', () => ({
  shouldUseNativeProjectDirectoryPicker: () => automationMocks.useNativeDirectoryPicker,
}))

vi.mock('@/lib/native-directory-picker', () => ({
  openNativeProjectDirectoryPicker: nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker,
  openNativeProjectDirectoryPickers: async (...args: unknown[]) => {
    const selected = await nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker(...args)
    return selected ? [selected] : []
  },
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
    if (this.getAttribute('data-testid') === 'desktop-workbench-pane-stack-container') {
      return createRect({ left: 0, top: 0, width, height: 720 })
    }
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
  formatCodexUsageResetTime: vi.fn(() => null),
}))

vi.mock('@/features/auth/useAuth', async importOriginal => ({
  ...(await importOriginal<typeof import('@/features/auth/useAuth')>()),
  useAuth: () => ({
    logout: authMocks.logout,
  }),
}))

vi.mock('@/lib/local-terminal', () => ({
  archiveLocalHarnessSession: vi.fn(),
  closeLocalTerminal: vi.fn(),
  getLocalPathKind: vi.fn(),
  getLocalExecutorDeviceId: vi.fn(),
  isLocalHarnessAvailable: vi.fn(),
  isLocalTerminalAvailable: vi.fn(),
  listLocalHarnesses: vi.fn().mockResolvedValue([]),
  listLocalHarnessSessions: vi.fn().mockResolvedValue([]),
  listLocalWorkspaceOpeners: vi
    .fn()
    .mockResolvedValue([{ id: 'vscode', category: 'general', available: true }]),
  localPathExists: vi.fn(),
  openLocalWorkspace: vi.fn(),
  pickLocalWorkspaceOpenerExe: vi.fn().mockResolvedValue(null),
  resolveLocalHarnessPluginRoots: vi.fn().mockResolvedValue([]),
  startLocalHarness: vi.fn(),
  startLocalTerminal: vi.fn(),
  WEWORK_LOCAL_HARNESS_SESSIONS_CHANGED_EVENT: 'wework:local-harness-sessions-changed',
}))

vi.mock('@/components/code/PierreCodeProvider', () => ({
  PierreCodeProvider: ({ children }: { children: React.ReactNode }) => children,
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
    expandedPaths: Set<string>
    search: string | null
    selectedPaths: string[]
    onSelectionChange?: (paths: string[]) => void
    getItem: (path: string) => {
      expand: () => void
      isDirectory: () => boolean
      isExpanded: () => boolean
      select: () => void
      deselect: () => void
    } | null
    getSelectedPaths: () => string[]
    scrollToPath: () => void
    subscribe: (listener: () => void) => () => void
    notify: () => void
    resetPaths: (paths: string[], options?: { initialExpandedPaths?: string[] }) => void
    selectPath: (path: string) => void
    setSearch: (query: string | null) => void
  }

  function selectModelPath(model: MockTreeModel, path: string) {
    if (model.selectedPaths[0] === path) return

    model.selectedPaths = [path]
    model.onSelectionChange?.([path])
    model.notify()
  }

  return {
    FileTree: ({ model, ...props }: { model: MockTreeModel; [key: string]: unknown }) => {
      const [, rerender] = React.useReducer((version: number) => version + 1, 0)
      React.useEffect(() => model.subscribe(rerender), [model])
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
                aria-expanded={isDirectory ? model.expandedPaths.has(path) : undefined}
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
      initialExpandedPaths,
      initialSelectedPaths,
      onSelectionChange,
      paths,
    }: {
      initialExpandedPaths?: string[]
      initialSelectedPaths?: string[]
      onSelectionChange?: (paths: string[]) => void
      paths: string[]
    }) => {
      const modelRef = React.useRef<MockTreeModel | null>(null)

      if (!modelRef.current) {
        const listeners = new Set<() => void>()
        modelRef.current = {
          paths,
          expandedPaths: new Set(initialExpandedPaths),
          search: null,
          selectedPaths: initialSelectedPaths ?? [],
          onSelectionChange,
          getItem: (path: string) => {
            const model = modelRef.current!
            if (!model.paths.includes(path)) return null
            return {
              expand: () => {
                model.expandedPaths.add(path)
                model.notify()
              },
              isDirectory: () => path.endsWith('/'),
              isExpanded: () => model.expandedPaths.has(path),
              select: () => selectModelPath(model, path),
              deselect: () => {
                model.selectedPaths = model.selectedPaths.filter(selected => selected !== path)
                model.notify()
              },
            }
          },
          getSelectedPaths: () => modelRef.current!.selectedPaths,
          scrollToPath: vi.fn(),
          subscribe: listener => {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
          notify: () => listeners.forEach(listener => listener()),
          resetPaths(nextPaths, options) {
            this.paths = nextPaths
            this.expandedPaths = new Set(options?.initialExpandedPaths)
            this.selectedPaths = this.selectedPaths.filter(path => nextPaths.includes(path))
            this.notify()
          },
          selectPath: (path: string) => selectModelPath(modelRef.current!, path),
          setSearch(query: string | null) {
            if (this.search === query) return
            this.search = query
            this.notify()
          },
        }
      }

      return { model: modelRef.current }
    },
  }
})

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

const localTerminalExitCallbacks = vi.hoisted(() => new Map<string, () => void>())

vi.mock('./workspace-panels/EmbeddedLocalTerminal', () => ({
  EmbeddedLocalTerminal: ({
    active,
    sessionId,
    onExit,
    testIdsEnabled = true,
  }: {
    active: boolean
    sessionId: string
    onExit?: () => void
    testIdsEnabled?: boolean
  }) => {
    if (onExit) localTerminalExitCallbacks.set(sessionId, onExit)
    return (
      <div
        data-testid={testIdsEnabled ? 'embedded-local-terminal' : undefined}
        data-session-id={sessionId}
        hidden={!active}
      />
    )
  },
}))

const createDeviceApiMock = vi.mocked(createDeviceApi)
const createProjectApiMock = vi.mocked(createProjectApi)
const getLocalCodexUsageDisplayMock = vi.mocked(getLocalCodexUsageDisplay)
const archiveLocalHarnessSessionMock = vi.mocked(archiveLocalHarnessSession)
const closeLocalTerminalMock = vi.mocked(closeLocalTerminal)
const getLocalExecutorDeviceIdMock = vi.mocked(getLocalExecutorDeviceId)
const isLocalHarnessAvailableMock = vi.mocked(isLocalHarnessAvailable)
const isLocalTerminalAvailableMock = vi.mocked(isLocalTerminalAvailable)
const listLocalHarnessesMock = vi.mocked(listLocalHarnesses)
const listLocalHarnessSessionsMock = vi.mocked(listLocalHarnessSessions)
const localPathExistsMock = vi.mocked(localPathExists)
const getLocalPathKindMock = vi.mocked(getLocalPathKind)
const openLocalWorkspaceMock = vi.mocked(openLocalWorkspace)
const startLocalHarnessMock = vi.mocked(startLocalHarness)
const resolveLocalHarnessLaunchMock = vi.fn()
const unregisterHarnessProxyMock = vi.fn()
const startLocalTerminalMock = vi.mocked(startLocalTerminal)
const startTerminalSessionMock = vi.fn()
const startCodeServerSessionMock = vi.fn()
const startDeviceTerminalSessionMock = vi.fn()
const startDeviceCodeServerSessionMock = vi.fn()
const createRemoteTerminalClientMock = vi.fn()
let sideChatLifecycleStore: RuntimeTaskLifecycleStore
const createTemporaryRuntimeTaskMock = vi.fn()
const sendRuntimePaneMessageMock = vi.fn().mockResolvedValue(true)
const sendRuntimePaneGuidanceMock = vi.fn().mockResolvedValue({
  sent: true,
  turnId: 'runtime-side-chat-turn',
})
const subscribeRuntimeTaskStreamMock = vi.fn(() => vi.fn())

type CreateTemporaryRuntimeTaskOptions = Parameters<
  WorkbenchContextValue['createTemporaryRuntimeTask']
>[1]

async function openOptimisticTemporaryRuntimeTask(
  address: RuntimeTaskAddress,
  options: CreateTemporaryRuntimeTaskOptions
) {
  address.runtimeHandle ??= {
    modelSelection: {
      modelName: 'test-model',
      modelType: 'user',
      options: {},
    },
  }
  if (options?.optimisticUserMessage) {
    applyRuntimeConversationAction(address, {
      type: 'user_added',
      message: options.optimisticUserMessage,
    })
  }
  await options?.onRuntimeTaskOptimisticOpen?.(address)
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

describe('DesktopWorkbenchLayout', () => {
  beforeAll(async () => {
    configure({ asyncUtilTimeout: 5_000 })
    vi.setConfig({ testTimeout: 30_000 })
  })

  afterAll(() => {
    configure({ asyncUtilTimeout: 1_000 })
    vi.resetConfig()
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

  function setComposerValue(container: HTMLElement, value: string) {
    const editor = within(container).getByTestId('chat-message-input') as HTMLElement & {
      value: string
    }
    act(() => {
      editor.value = value
    })
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
          client_ip: '10.201.3.200',
          cloud_config: {
            deviceName: 'yunpeng7-executor-372706c30fcd',
          },
          cpu_usage: 42,
          memory_usage: 68,
          disk_usage: 57,
        },
      ]),
      startTerminal: startDeviceTerminalSessionMock,
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
      ...overrides,
    }
  }

  beforeEach(async () => {
    vi.restoreAllMocks()
    await installPierreEditorTestPlatform()
    await preloadDefaultDshUiTestModules()
    await installGitUiTestContributions()
    experimentalFeatures.enabled = true
    runtimeMocks.electron = false
    vi.clearAllMocks()
    deviceExecuteCommandMock.mockReset()
    deviceExecuteCommandMock.mockRejectedValue(new Error('Device command is not configured'))
    deliveryApiMock.available = false
    deliveryApiMock.runtimePortAvailable = false
    deliveryApiMock.listCloudProjects.mockResolvedValue({ items: [] })
    deliveryApiMock.listCloudFiles.mockResolvedValue({ items: [] })
    deliveryApiMock.listLoopItems.mockResolvedValue({ items: [] })
    deliveryApiMock.listDeliveries.mockResolvedValue({ items: [] })
    deliveryApiMock.listTaskBindings.mockResolvedValue([])
    deliveryApiMock.findCloudContextForTask.mockRejectedValue(new Error('Context not found'))
    deliveryApiMock.trackProjectTask.mockImplementation(() => new Promise(() => {}))
    deliveryApiMock.findRuntimeContext.mockRejectedValue(new Error('Context not found'))
    deliveryApiMock.findRuntimeIssue.mockRejectedValue(new Error('Issue not found'))
    deviceSurfaceExtensionMock.available = false
    deviceSurfaceExtensionMock.launch.mockResolvedValue(true)
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1024,
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 720,
    })
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
    setActiveKeybindings([])
    document.getElementById(TITLEBAR_ACTIONS_PORTAL_ID)?.remove()
    document.getElementById(TITLEBAR_FEEDBACK_PORTAL_ID)?.remove()
    document.getElementById(TITLEBAR_RIGHT_PANEL_PORTAL_ID)?.remove()
    screen.queryByTestId('titlebar-right-workspace-zone')?.remove()
    localStorage.clear()
    sessionStorage.clear()
    window.history.pushState({}, '', '/')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
    Element.prototype.scrollIntoView = vi.fn()
    Element.prototype.scrollTo = vi.fn()
    localTerminalExitCallbacks.clear()
    isLocalTerminalAvailableMock.mockReturnValue(false)
    isLocalHarnessAvailableMock.mockImplementation(() => isLocalTerminalAvailableMock())
    listLocalHarnessesMock.mockResolvedValue([])
    listLocalHarnessSessionsMock.mockResolvedValue([])
    getLocalPathKindMock.mockResolvedValue('file')
    getLocalExecutorDeviceIdMock.mockResolvedValue(null)
    localPathExistsMock.mockResolvedValue(false)
    openLocalWorkspaceMock.mockResolvedValue(undefined)
    startLocalHarnessMock.mockReset().mockResolvedValue('local-harness-1')
    resolveLocalHarnessLaunchMock.mockImplementation(async harnessId => ({
      modelId:
        harnessId === 'claude_code'
          ? 'wework-selected'
          : harnessId === 'kimi_code'
            ? '__kimi_env_model__'
            : 'wework-messages/wework-selected',
      proxyToken: 'proxy-token',
      env:
        harnessId === 'claude_code'
          ? {
              ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234/v1/harness-router/proxy-token',
              ANTHROPIC_API_KEY: 'wework-local-router',
            }
          : harnessId === 'kimi_code'
            ? {
                KIMI_MODEL_NAME: 'wework-selected',
                KIMI_MODEL_PROVIDER_TYPE: 'anthropic',
                KIMI_MODEL_BASE_URL: 'http://127.0.0.1:1234/v1/harness-router/proxy-token',
                KIMI_MODEL_API_KEY: 'wework-local-router',
              }
            : { OPENCODE_CONFIG_CONTENT: '{"provider":{}}' },
    }))
    harnessAppMocks.list.mockResolvedValue([])
    harnessAppMocks.addPlugin.mockReset()
    harnessAppMocks.inspectVerification.mockReset().mockResolvedValue(null)
    harnessAppMocks.start.mockReset()
    harnessAppMocks.stop.mockReset().mockResolvedValue(undefined)
    harnessAppMocks.verify.mockReset()
    embeddedBrowserMocks.closeEmbeddedBrowser.mockClear()
    embeddedBrowserMocks.setEmbeddedBrowserActiveTab.mockClear()
    harnessAppTabMocks.takeProxyToken.mockResolvedValue(null)
    harnessAppTabMocks.takeContextToken.mockResolvedValue(null)
    harnessAppTabMocks.takeDecisionToken.mockResolvedValue(null)
    unregisterHarnessProxyMock.mockResolvedValue(undefined)
    nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker.mockResolvedValue(null)
    automationMocks.useNativeDirectoryPicker = true
    openExternalUrlMock.mockResolvedValue(true)
    startLocalTerminalMock.mockResolvedValue('local-terminal-1')
    archiveLocalHarnessSessionMock.mockResolvedValue(undefined)
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
    startDeviceCodeServerSessionMock.mockResolvedValue({
      url: 'http://localhost/ide',
      path: '/workspace/project',
    })
    startTerminalSessionMock.mockResolvedValue({
      session_id: 'terminal-1',
      url: '',
      transport: 'socketio',
      device_id: 'workspace-cloud-device',
      path: '/workspace/project',
    })
    startDeviceTerminalSessionMock.mockResolvedValue({
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
    createTemporaryRuntimeTaskMock.mockResolvedValue(false)
    clearRuntimeConversationCacheForTests()
    sendRuntimePaneMessageMock.mockReset()
    sendRuntimePaneMessageMock.mockResolvedValue(true)
    sendRuntimePaneGuidanceMock.mockReset()
    sendRuntimePaneGuidanceMock.mockResolvedValue({
      sent: true,
      turnId: 'runtime-side-chat-turn',
    })
    subscribeRuntimeTaskStreamMock.mockReturnValue(vi.fn())
    baseProps.projectChat.inputByScope = {}
    baseProps.projectChat.setInputForScope.mockReset()
    baseProps.projectChat.setInputForScope.mockImplementation((scope: string, value: string) => {
      if (value) baseProps.projectChat.inputByScope[scope] = value
      else delete baseProps.projectChat.inputByScope[scope]
    })
  }, 60_000)

  const baseProps = {
    state: {
      user: null,
      projects: [{ id: 1, name: 'github_wegent', tasks: [] }],
      devices: [],
      runtimeWork: null,
      runtimeWorkLoad: { phase: 'loading', error: null },
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
      inputByScope: {} as Record<string, string>,
      setInputForScope: vi.fn(),
      models: [],
      skills: [],
      selectedModel: null,
      selectedModelOptions: {},
      selectedSkills: [],
      attachmentStateByScope: {},
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
      handleFileSelectForScope: vi.fn(),
      addExistingAttachment: vi.fn(),
      addExistingAttachmentForScope: vi.fn(),
      removeAttachment: vi.fn(),
      removeAttachmentForScope: vi.fn(),
      resetAttachments: vi.fn(),
      resetAttachmentsForScope: vi.fn(),
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
    onCloneGitRepository: vi.fn(),
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
  const harnessTestModel = {
    name: 'local-model:test',
    type: 'runtime' as const,
    provider: 'local',
    displayName: 'Test Model',
    modelId: 'test-model',
    config: { weworkModelKind: 'model-interface' },
  }

  const activeProjectState = {
    ...baseProps.state,
    currentProject: {
      id: 1,
      name: 'github_wegent',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: 'device-1',
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/workspace/github_wegent',
        },
      },
    },
  }

  const activeProjectRuntimeTask = {
    deviceId: 'device-1',
    workspacePath: '/workspace/github_wegent',
    taskId: 'runtime-project-1',
  }
  const activeProjectRuntimeTarget = {
    deviceId: 'device-1',
    path: '/workspace/github_wegent',
    source: 'runtime' as const,
    taskId: 'runtime-project-1',
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

  type LegacyDesktopWorkbenchLayoutProps = {
    state?: Record<string, unknown>
    messages?: WorkbenchMessage[]
    queuedMessages?: unknown[]
    guidanceMessages?: unknown[]
    codeCommentContexts?: unknown[]
    subagentStatuses?: RuntimeSubagentStatus[]
    workspaceFileApi?: WorkbenchContextValue['workspaceFileApi']
    workspaceTabId?: string
    runtimeWorkApi?: WorkbenchServices['runtimeWorkApi']
    runtimeTaskReminders?: RuntimeTaskReminderState
    lifecycleTaskRunning?: boolean
    isAwaitingAssistantStart?: boolean
    isRuntimeTranscriptLoading?: boolean
    runtimeTranscriptHasMoreBefore?: boolean
    isRuntimeTranscriptLoadingMore?: boolean
    projectChat?: Partial<ProjectChatControls>
    projectWork?: Record<string, unknown>
    onSelectProject?: (projectId: number | null) => void
    onNewChat?: () => void
    onStartStandaloneChat?: () => void
    onStartNewProjectChat?: (projectId: number) => void
    onOpenStandaloneWorkspace?: (...args: unknown[]) => Promise<void> | void
    onOpenRuntimeTask?: (...args: unknown[]) => Promise<void> | void
    onSearchRuntimeWork?: (...args: unknown[]) => Promise<unknown>
    onLoadRuntimeTranscriptForPane?: WorkbenchContextValue['loadRuntimeTranscriptForPane']
    onCancelRuntimePaneTask?: WorkbenchContextValue['cancelRuntimePaneTask']
    onForkCurrentRuntimeTask?: WorkbenchContextValue['forkCurrentRuntimeTask']
    onListImPrivateSessions?: () => Promise<unknown>
    onGetImNotificationSettings?: () => Promise<unknown>
    onUpdateGlobalImNotification?: (...args: unknown[]) => Promise<unknown>
    onSubscribeRuntimeTaskNotifications?: (...args: unknown[]) => Promise<unknown>
    onUnsubscribeRuntimeTaskNotifications?: (...args: unknown[]) => Promise<unknown>
    onRefreshDevices?: () => Promise<void>
    onUpgradeDevice?: (...args: unknown[]) => Promise<void>
    onCreateProject?: (...args: unknown[]) => Promise<unknown>
    onCreateLocalRuntimeProject?: WorkbenchContextValue['createLocalRuntimeProject']
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
    onCloneGitRepository?: (...args: unknown[]) => Promise<void>
    onLoadEnvironmentInfo?: (...args: unknown[]) => Promise<unknown>
    onLoadEnvironmentDiff?: (...args: unknown[]) => Promise<string>
    onCommitEnvironmentChanges?: (...args: unknown[]) => Promise<void>
    onCommitAndPushEnvironmentChanges?: (...args: unknown[]) => Promise<void>
    onPushEnvironmentChanges?: (...args: unknown[]) => Promise<void>
    onListEnvironmentBranches?: (...args: unknown[]) => Promise<string[]>
    onCheckoutEnvironmentBranch?: (...args: unknown[]) => Promise<void>
    onCreateEnvironmentBranch?: (...args: unknown[]) => Promise<void>
    onInputChange?: (input: string) => void
    onSend?: () => void | Promise<void>
    onRequestUserInputSubmit?: (...args: unknown[]) => Promise<boolean> | void
    onLogout?: () => void
  }

  function DesktopWorkbenchLayout(
    props: LegacyDesktopWorkbenchLayoutProps & {
      routeActive?: boolean
      surfaceKind?: 'task' | 'board'
      popout?: boolean
    }
  ) {
    const { authValue, workbenchValue, paneValue, paneSession } = createWorkbenchMocks(props)
    paneSessionMockRef.current = paneSession
    const lifecycleTaskRunning =
      props.lifecycleTaskRunning ?? Boolean(workbenchValue.state.currentRuntimeTask)
    const lifecycleStore = useMemo(() => {
      const store = new RuntimeTaskLifecycleStore('desktop-workbench-layout-test')
      store.syncRuntimeWork(workbenchValue.state.runtimeWork)
      if (lifecycleTaskRunning && workbenchValue.state.currentRuntimeTask) {
        store.executorStarted(workbenchValue.state.currentRuntimeTask)
      }
      return store
    }, [
      lifecycleTaskRunning,
      workbenchValue.state.currentRuntimeTask,
      workbenchValue.state.runtimeWork,
    ])

    sideChatLifecycleStore = lifecycleStore
    return (
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <AppearanceProvider>
          <AuthContext.Provider value={authValue}>
            <WorkbenchContext.Provider value={workbenchValue}>
              <WorkbenchPaneContext.Provider value={paneValue}>
                {props.popout ? (
                  <PopoutWorkbenchPage />
                ) : (
                  <ActualDesktopWorkbenchLayout
                    routeActive={props.routeActive}
                    surfaceKind={props.surfaceKind}
                  />
                )}
              </WorkbenchPaneContext.Provider>
            </WorkbenchContext.Provider>
          </AuthContext.Provider>
        </AppearanceProvider>
      </RuntimeTaskLifecycleProvider>
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
    const projectChatBase = {
      ...baseProps.projectChat,
      isModelSelectionReady: true,
      onBlockedModelSelect: vi.fn(),
      ...props.projectChat,
    }
    const projectChat = {
      ...projectChatBase,
      resolveRuntimeTaskModelSelection:
        projectChatBase.resolveRuntimeTaskModelSelection ??
        ((address: RuntimeTaskAddress) => {
          const taskSelection = resolveTemporaryChatModelSelection(runtimeWork, address)
          const taskModel = resolveTemporaryChatActiveModel(
            projectChatBase.models,
            runtimeWork,
            address
          )
          return {
            taskSelection,
            selectedModel: taskModel,
            activeModel: taskModel,
            selectedModelOptions: taskSelection?.options ?? {},
          }
        }),
      setRuntimeTaskSelectedModel: projectChatBase.setRuntimeTaskSelectedModel ?? vi.fn(),
      setRuntimeTaskSelectedModelAndOptions:
        projectChatBase.setRuntimeTaskSelectedModelAndOptions ?? vi.fn(),
      setRuntimeTaskSelectedModelOption:
        projectChatBase.setRuntimeTaskSelectedModelOption ?? vi.fn(),
    }
    const lifecycleTaskRunning = props.lifecycleTaskRunning ?? Boolean(state.currentRuntimeTask)
    const workbenchValue = {
      services: {
        deviceApi: {
          listDevices: vi.fn(async () => []),
          listSkills: vi.fn(async () => []),
          readWorkspaceFileChunk: vi.fn(),
          executeCommand: deviceExecuteCommandMock,
        },
        ...(deliveryApiMock.available
          ? {
              deliveryApi: {
                listCloudProjects: deliveryApiMock.listCloudProjects,
                listCloudFiles: deliveryApiMock.listCloudFiles,
                listLoopItems: deliveryApiMock.listLoopItems,
                listDeliveries: deliveryApiMock.listDeliveries,
                listTaskBindings: deliveryApiMock.listTaskBindings,
                findCloudContextForTask: deliveryApiMock.findCloudContextForTask,
                trackProjectTask: deliveryApiMock.trackProjectTask,
              },
              sharedWorkspaceApi: sharedWorkspaceApiMock,
              ...(deliveryApiMock.runtimePortAvailable
                ? {
                    workspaceRuntimePort: {
                      findCloudContextForTask: deliveryApiMock.findRuntimeContext,
                      findIssueForTask: deliveryApiMock.findRuntimeIssue,
                    },
                  }
                : {}),
            }
          : {}),
        attachmentApi: {
          uploadAttachment: vi.fn().mockImplementation(async (file: File) => ({
            id: 91,
            filename: file.name,
            file_size: file.size,
            mime_type: file.type,
            status: 'ready',
            file_extension: file.name.split('.').pop() ?? '',
            created_at: '2026-07-22T00:00:00Z',
          })),
          deleteAttachment: vi.fn().mockResolvedValue(undefined),
        },
        workspaceSessionApi: {
          startProjectTerminal: startTerminalSessionMock,
          startProjectCodeServer: startCodeServerSessionMock,
          startDeviceTerminal: startDeviceTerminalSessionMock,
          startDeviceCodeServer: startDeviceCodeServerSessionMock,
          createRemoteTerminalClient: createRemoteTerminalClientMock,
        },
        localHarnessModelApi: {
          resolveLaunch: resolveLocalHarnessLaunchMock,
          unregisterProxy: unregisterHarnessProxyMock,
          unregisterContext: vi.fn(),
        },
        ...(props.runtimeWorkApi ? { runtimeWorkApi: props.runtimeWorkApi } : {}),
      },
      workspaceTabId: props.workspaceTabId,
      state,
      isStartupReady: true,
      setWorkbenchError: vi.fn(),
      workspaceFileApi: props.workspaceFileApi ?? baseProps.workspaceFileApi,
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
      startNewChat: props.onNewChat ?? baseProps.onNewChat,
      startStandaloneChat: props.onStartStandaloneChat ?? vi.fn(),
      startNewProjectChat: props.onStartNewProjectChat ?? baseProps.onStartNewProjectChat,
      openRuntimeTask: props.onOpenRuntimeTask ?? vi.fn().mockResolvedValue(undefined),
      searchRuntimeWork: props.onSearchRuntimeWork ?? vi.fn().mockResolvedValue({ items: [] }),
      loadRuntimeTranscriptForPane:
        props.onLoadRuntimeTranscriptForPane ?? vi.fn().mockResolvedValue({ messages: [] }),
      subscribeRuntimeTaskStream: subscribeRuntimeTaskStreamMock,
      renameRuntimeTask: vi.fn().mockResolvedValue(undefined),
      archiveRuntimeTask: vi.fn().mockResolvedValue(undefined),
      archiveProjectConversations: vi.fn().mockResolvedValue(undefined),
      archiveProjectsConversations: vi.fn().mockResolvedValue(undefined),
      archiveChatConversations: vi.fn().mockResolvedValue(undefined),
      forkCurrentRuntimeTask:
        props.onForkCurrentRuntimeTask ?? vi.fn().mockResolvedValue(undefined),
      listImPrivateSessions:
        props.onListImPrivateSessions ?? vi.fn().mockResolvedValue({ total: 0, items: [] }),

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
      runtimeTaskReminders: props.runtimeTaskReminders,
      refreshWorkLists: vi.fn().mockResolvedValue(undefined),
      refreshDevices: props.onRefreshDevices ?? vi.fn().mockResolvedValue(undefined),
      upgradeDevice: props.onUpgradeDevice ?? vi.fn().mockResolvedValue(undefined),
      createProject:
        props.onCreateProject ?? baseProps.onCreateProject ?? vi.fn().mockResolvedValue({}),
      createLocalRuntimeProject:
        props.onCreateLocalRuntimeProject ??
        vi.fn().mockResolvedValue({ id: 99, name: 'Created project', tasks: [] }),
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
      cloneGitRepository: props.onCloneGitRepository ?? baseProps.onCloneGitRepository,
      loadEnvironmentInfo: props.onLoadEnvironmentInfo ?? baseProps.onLoadEnvironmentInfo,
      loadEnvironmentDiff: props.onLoadEnvironmentDiff ?? baseProps.onLoadEnvironmentDiff,
      commitEnvironmentChanges:
        props.onCommitEnvironmentChanges ?? baseProps.onCommitEnvironmentChanges,
      commitAndPushEnvironmentChanges:
        props.onCommitAndPushEnvironmentChanges ?? vi.fn().mockResolvedValue(undefined),
      pushEnvironmentChanges:
        props.onPushEnvironmentChanges ?? vi.fn().mockResolvedValue(undefined),
      listEnvironmentBranches:
        props.onListEnvironmentBranches ?? baseProps.onListEnvironmentBranches,
      checkoutEnvironmentBranch:
        props.onCheckoutEnvironmentBranch ?? baseProps.onCheckoutEnvironmentBranch,
      createEnvironmentBranch:
        props.onCreateEnvironmentBranch ?? baseProps.onCreateEnvironmentBranch,
      sendRuntimePaneMessage: sendRuntimePaneMessageMock,
      sendRuntimePaneGuidance: sendRuntimePaneGuidanceMock,
      cancelRuntimePaneTask: props.onCancelRuntimePaneTask ?? vi.fn().mockResolvedValue(true),
      sendCurrentInput: props.onSend ?? baseProps.onSend,
      createTemporaryRuntimeTask: createTemporaryRuntimeTaskMock,
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
        runtimeWorkLoad: state.runtimeWorkLoad,
        standaloneDeviceId: state.standaloneDeviceId,
        selectedDeviceWorkspaceId: state.selectedDeviceWorkspaceId,
        pendingProjectWorkspaceProjectId: state.pendingProjectWorkspaceProjectId,
        user: state.user,
        error: state.error,
      },
    } as unknown as WorkbenchPaneContextValue
    const paneSession = {
      scopeKey: projectChat.scopeKey,
      attachments: projectChat.attachments,
      uploadingFiles: projectChat.uploadingFiles,
      attachmentErrors: projectChat.errors,
      handleFileSelect: projectChat.handleFileSelect,
      removeAttachment: projectChat.removeAttachment,
      messages: props.messages ?? [],
      queuedMessages: props.queuedMessages ?? [],
      guidanceMessages: props.guidanceMessages ?? [],
      codeCommentContexts: props.codeCommentContexts ?? [],
      input: String(state.input ?? ''),
      setInput: props.onInputChange ?? baseProps.onInputChange,
      replaceInput: props.onInputChange ?? baseProps.onInputChange,
      replaceDraftKey: 0,
      onDraftEdit: vi.fn(),
      getDraftEditVersion: () => 0,
      setError: vi.fn(),
      clearError: vi.fn(),
      sending: Boolean(state.isSending),
      waitingForAssistant: Boolean(props.isAwaitingAssistantStart),
      status: createPaneStatus({
        messages: props.messages ?? [],
        sending: Boolean(state.isSending),
        waitingForAssistant: Boolean(props.isAwaitingAssistantStart),
        taskRunning: lifecycleTaskRunning,
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
      retryFailedMessage: vi.fn().mockResolvedValue(true),
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
      runtime_features: {
        schemaVersion: 4,
      },
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

  function createLocalSkillDevice() {
    return {
      id: 13,
      device_id: 'device-local-real',
      name: 'Local Mac',
      status: 'online' as const,
      is_default: true,
      device_type: 'local' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
  }

  function renderWorkspacePanelLayout({
    mainWidth,
    withAppearance = false,
    messages,
    currentRuntimeTask = null,
    onLoadRuntimeTranscriptForPane,
    workspaceFileApi = baseProps.workspaceFileApi,
  }: {
    mainWidth?: number
    withAppearance?: boolean
    messages?: WorkbenchMessage[]
    currentRuntimeTask?: RuntimeTaskAddress | null
    onLoadRuntimeTranscriptForPane?: WorkbenchContextValue['loadRuntimeTranscriptForPane']
    workspaceFileApi?: WorkspaceFileApi
  } = {}) {
    if (mainWidth) {
      mockDesktopWorkbenchMainWidth(mainWidth)
    }

    const workspacePanelState = createCloudWorkspacePanelState()
    const layout = (
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={workspaceFileApi}
        messages={messages}
        onLoadRuntimeTranscriptForPane={onLoadRuntimeTranscriptForPane}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
          currentRuntimeTask,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )
    return render(withAppearance ? <AppearanceProvider>{layout}</AppearanceProvider> : layout)
  }

  function createLocalRuntimeTaskPanelFixture(taskCount = 11) {
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
    const taskSuffixes = 'abcdefghijk'.slice(0, taskCount).split('')
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

  test('routes a retained My Tasks board to the dedicated work-items surface', () => {
    deliveryApiMock.available = true
    deliveryApiMock.listCloudProjects.mockResolvedValue({
      items: [
        {
          id: 'default-work-items',
          public_id: 'default-work-items',
          project_key: 'WORK',
          name: '我的任务',
          description: '',
          project_store: 'local',
          task_provider: 'local',
          provider_config: {},
          created_by_user_id: 1,
          status: 'active',
          tags: [],
          version: 1,
          created_at: '2026-09-14T00:00:00Z',
          updated_at: '2026-09-14T00:00:00Z',
          metadata: { system_kind: 'default_work_items' },
        },
      ],
    })
    const boardTab = {
      id: 'board-my-tasks',
      kind: 'board' as const,
      title: '我的任务',
      contentRoute: '/todo?projectStore=local&projectId=default-work-items',
      fixed: false,
    }
    const workspaceTabs = {
      tabs: [boardTab],
      activeTabId: boardTab.id,
      activeTab: boardTab,
      openTab: vi.fn(),
      selectTab: vi.fn(),
      closeTab: vi.fn(),
      closeOtherTabs: vi.fn(),
      restoreClosedTab: vi.fn(),
      moveTab: vi.fn(),
      updateTab: vi.fn(),
      updateActiveTab: vi.fn(),
    } as unknown as WorkspaceTabsContextValue

    render(
      <WorkspaceTabsContext.Provider value={workspaceTabs}>
        <DesktopWorkbenchLayout
          {...baseProps}
          surfaceKind="board"
          workspaceTabId={boardTab.id}
          state={{
            ...baseProps.state,
            user: {
              id: 1,
              user_name: 'local',
              email: 'local@example.com',
            },
          }}
        />
      </WorkspaceTabsContext.Provider>
    )

    expect(screen.getByTestId('cloud-todo-workspace')).toHaveAttribute('data-embedded', 'true')
    expect(screen.queryByTestId('wework-collaboration-platform')).not.toBeInTheDocument()
  })

  test('keeps a retained board bound to its own workspace tab route', async ({
    onTestFinished,
  }) => {
    const dialogMethods = ['showModal', 'close'] as const
    const descriptors = dialogMethods.map(method =>
      Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method)
    )
    for (const method of dialogMethods) {
      Object.defineProperty(HTMLDialogElement.prototype, method, {
        configurable: true,
        value: function (this: HTMLDialogElement) {
          this.open = method === 'showModal'
        },
      })
    }
    onTestFinished(() => {
      cleanup()
      dialogMethods.forEach((method, index) => {
        const descriptor = descriptors[index]
        if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor)
        else Reflect.deleteProperty(HTMLDialogElement.prototype, method)
      })
    })
    deliveryApiMock.available = true
    const project = {
      id: 'project-1',
      workspace_id: 'workspace-1',
      public_id: 'public-project-1',
      project_key: 'PROJECT-1',
      name: 'Retained Project',
      description: '',
      project_store: 'backend',
      task_provider: 'local',
      provider_config: {},
      created_by_user_id: 1,
      access_role: 'Owner',
      status: 'active',
      tags: [],
      version: 1,
      created_at: '2026-08-09T00:00:00Z',
      updated_at: '2026-08-09T00:00:00Z',
    }
    deliveryApiMock.listCloudProjects.mockResolvedValue({ items: [project] })
    const boardTab = {
      id: 'board-project-1',
      kind: 'board' as const,
      title: project.name,
      contentRoute: '/todo?projectStore=backend&projectId=project-1',
      fixed: false,
    }
    const taskTab = {
      id: 'fixed-task',
      kind: 'task' as const,
      title: '任务',
      contentRoute: '/',
      fixed: true,
    }
    const actions = {
      openTab: vi.fn(),
      selectTab: vi.fn(),
      closeTab: vi.fn(),
      closeOtherTabs: vi.fn(),
      restoreClosedTab: vi.fn(),
      moveTab: vi.fn(),
      updateTab: vi.fn(),
      updateActiveTab: vi.fn(),
    }
    const workspaceTabs = (activeTab: typeof boardTab | typeof taskTab) => ({
      tabs: [taskTab, boardTab],
      activeTabId: activeTab.id,
      activeTab,
      ...actions,
    })
    const props = {
      ...baseProps,
      workspaceTabId: boardTab.id,
      surfaceKind: 'board' as const,
      state: {
        ...baseProps.state,
        user: {
          id: 1,
          user_name: 'local',
          email: 'local@example.com',
        },
      },
    }
    const view = render(
      <WorkspaceTabsContext.Provider value={workspaceTabs(boardTab)}>
        <DesktopWorkbenchLayout {...props} />
      </WorkspaceTabsContext.Provider>
    )

    expect(await screen.findByTestId('cloud-project-header')).toHaveTextContent(project.name)
    await userEvent.click(screen.getByTestId('board-view-picker'))
    await userEvent.click(screen.getByTestId('board-view-edit'))
    expect(screen.getByTestId('board-view-editor')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '看板设置' })).toHaveClass(
      'text-heading-sm',
      'font-medium'
    )

    view.rerender(
      <WorkspaceTabsContext.Provider value={workspaceTabs(taskTab)}>
        <DesktopWorkbenchLayout {...props} routeActive={false} />
      </WorkspaceTabsContext.Provider>
    )

    expect(screen.getByTestId('cloud-project-header')).toHaveTextContent(project.name)
    expect(screen.getByTestId('board-view-editor')).toBeInTheDocument()
    expect(actions.updateActiveTab).not.toHaveBeenCalled()

    view.rerender(
      <WorkspaceTabsContext.Provider value={workspaceTabs(boardTab)}>
        <DesktopWorkbenchLayout {...props} />
      </WorkspaceTabsContext.Provider>
    )

    expect(screen.getByTestId('cloud-project-header')).toHaveTextContent(project.name)
    expect(screen.getByTestId('board-view-editor')).toBeInTheDocument()
  })

  test('returns to the previous page after opening settings through direct navigation', async () => {
    deliveryApiMock.available = true
    window.history.pushState({}, '', '/todo')

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          user: {
            id: 1,
            user_name: 'local',
            email: 'local@example.com',
          },
        }}
      />
    )

    act(() => navigateTo('/settings'))
    expect(window.location.pathname).toBe('/settings')

    await userEvent.click(screen.getByTestId('settings-back-button'))

    expect(window.location.pathname).toBe('/todo')
    expect(await screen.findByTestId('wework-collaboration-platform')).toBeVisible()
  })

  test('keeps the active task return route when an inactive project space is retained', () => {
    const taskTab = {
      id: 'task-existing',
      kind: 'task' as const,
      title: '当前任务',
      contentRoute: '/runtime-tasks?deviceId=local-device&taskId=runtime-1',
    }
    const boardTab = {
      id: 'board-existing',
      kind: 'board' as const,
      title: '项目空间',
      contentRoute: '/todo?projectId=project-1',
    }
    const workspaceTabs = (activeTab: typeof taskTab | typeof boardTab) =>
      ({
        tabs: [taskTab, boardTab],
        activeTabId: activeTab.id,
        activeTab,
        openTab: vi.fn(),
        selectTab: vi.fn(),
        closeTab: vi.fn(),
        closeOtherTabs: vi.fn(),
        restoreClosedTab: vi.fn(),
        moveTab: vi.fn(),
        updateTab: vi.fn(),
        updateActiveTab: vi.fn(),
      }) as unknown as WorkspaceTabsContextValue

    window.sessionStorage.clear()
    window.history.pushState({}, '', taskTab.contentRoute)

    render(
      <>
        <WorkspaceTabsContext.Provider value={workspaceTabs(taskTab)}>
          <DesktopWorkbenchLayout {...baseProps} routeActive />
        </WorkspaceTabsContext.Provider>
        <WorkspaceTabsContext.Provider value={workspaceTabs(boardTab)}>
          <DesktopWorkbenchLayout {...baseProps} routeActive={false} surfaceKind="board" />
        </WorkspaceTabsContext.Provider>
      </>
    )

    act(() => navigateTo('/settings'))

    expect(window.sessionStorage.getItem('wework.settingsReturnPath')).toBe(taskTab.contentRoute)
  })

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

    const response = {
      requestId: 42,
      itemId: undefined,
      answers: {
        implement: { answers: ['是的，执行此计划'] },
      },
    }
    expect(onRequestUserInputSubmit).toHaveBeenCalledWith(response, {
      requestUserInputResponses: [response],
      appendUserMessage: true,
      forceDefaultCollaborationMode: true,
    })
  })

  test('keeps plan mode when submitting implementation plan adjustments', async () => {
    const onRequestUserInputSubmit = vi.fn().mockResolvedValue(true)
    const user = userEvent.setup()

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
        messages={[createPendingRequestUserInputMessage(true)]}
        onRequestUserInputSubmit={onRequestUserInputSubmit}
      />
    )

    await user.type(screen.getByTestId('request-user-input-custom-adjustment'), '先缩小范围')
    await user.click(screen.getByTestId('request-user-input-submit-button'))

    const response = {
      requestId: 42,
      itemId: undefined,
      answers: {
        adjustment: { answers: ['先缩小范围'] },
      },
    }
    expect(onRequestUserInputSubmit).toHaveBeenCalledWith(response, {
      requestUserInputResponses: [response],
      appendUserMessage: true,
      forceDefaultCollaborationMode: false,
    })
  })

  test('keeps the right workspace plan panel synced with the opened streaming plan block', async () => {
    const initialMessages: WorkbenchMessage[] = [
      {
        id: 'assistant-plan-block',
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: '2026-06-30T00:00:01.000Z',
        blocks: [
          {
            id: 'plan-1',
            subtaskId: '1',
            type: 'plan',
            content: '# Wegent 体验计划\n\n## Summary\n- 正在生成第一步。',
            status: 'streaming',
            createdAt: Date.parse('2026-06-30T00:00:01.000Z'),
          },
        ],
      },
    ]
    const { rerender } = render(
      <DesktopWorkbenchLayout {...baseProps} messages={initialMessages} />
    )

    await userEvent.click(screen.getByTestId('assistant-plan-expand-button'))

    expect(screen.getByTestId('workspace-plan-panel')).toHaveTextContent('正在生成第一步')

    rerender(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            ...initialMessages[0],
            blocks: [
              {
                ...initialMessages[0].blocks![0],
                content:
                  '# Wegent 体验计划\n\n## Summary\n- 正在生成第一步。\n- 已流式补充第二步。',
              },
            ],
          },
        ]}
      />
    )

    expect(screen.getByTestId('workspace-plan-panel')).toHaveTextContent('已流式补充第二步')
  })

  test('treats a selected runtime task with an empty transcript as a conversation', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.getAttribute('data-testid') === 'composer-toolbar') {
        return createRect({ left: 0, top: 0, width: 600, height: 32 })
      }
      return createRect({ left: 0, top: 0, width: 0, height: 0 })
    })

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
    expect(screen.queryByTestId('composer-plugin-picker-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-plugin-preview-icons')).not.toBeInTheDocument()
    const paneTitle = screen.getByTestId('workbench-pane-task-title')
    expect(paneTitle).toHaveTextContent('Fix pane title')
    expect(paneTitle).toHaveClass('truncate', 'text-sm', 'text-text-primary')
    expect(screen.getByTestId('workbench-topbar')).toHaveClass(
      'h-11',
      'border-b',
      'border-border/50',
      'bg-background/95'
    )
  })

  test('does not offer task-to-IM binding while experimental features are disabled', () => {
    experimentalFeatures.enabled = false

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
      />
    )

    expect(screen.queryByTestId('fork-runtime-task-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('continue-in-im-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workbench-harness-selector')).not.toBeInTheDocument()
  })

  test('retains the stand-in workspace when navigating away and back', async () => {
    window.history.replaceState({}, '', '/stand-in')
    render(<DesktopWorkbenchLayout {...baseProps} />)
    const workspace = screen.getByTestId('personal-stand-in-workspace')
    act(() => navigateTo('/'))
    expect(workspace).toBeInTheDocument()
    expect(workspace).not.toBeVisible()
    act(() => navigateTo('/stand-in'))
    expect(screen.getByTestId('personal-stand-in-workspace')).toBe(workspace)
    expect(workspace).toBeVisible()
  })

  test('mounts stand-in on first entry and retains it across route changes', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)
    expect(screen.queryByTestId('personal-stand-in-workspace')).not.toBeInTheDocument()

    act(() => navigateTo('/stand-in?deviceId=device-1'))
    const workspace = screen.getByTestId('personal-stand-in-workspace')
    expect(workspace).toBeVisible()
    act(() => navigateTo('/stand-in?deviceId=device-2'))
    expect(screen.getByTestId('personal-stand-in-workspace')).toBe(workspace)
    expect(workspace).toBeVisible()

    act(() => navigateTo('/'))
    act(() => navigateTo('/todo'))
    expect(workspace).toBeInTheDocument()
    expect(workspace).not.toBeVisible()
    act(() => navigateTo('/stand-in?deviceId=device-2'))
    expect(screen.getByTestId('personal-stand-in-workspace')).toBe(workspace)
    expect(workspace).toBeVisible()
  })

  test.each(['button', 'menu'])('opens My Tasks from stand-in using the board %s', async entry => {
    window.history.replaceState({}, '', '/stand-in?profileId=default')
    const onNavigate = vi.fn((event: Event) => event.preventDefault())
    window.addEventListener(WORKSPACE_NAVIGATION_EVENT, onNavigate)
    try {
      render(<DesktopWorkbenchLayout {...baseProps} />)
      expect(screen.getByTestId('personal-stand-in-button')).toHaveAttribute('aria-current', 'page')

      if (entry === 'button') {
        await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
      } else {
        await userEvent.click(screen.getByTestId('runtime-task-view-menu-button'))
        await userEvent.click(screen.getByTestId('runtime-task-view-board'))
      }

      expect(onNavigate).toHaveBeenCalledTimes(1)
      expect((onNavigate.mock.calls[0][0] as CustomEvent).detail).toEqual({
        kind: 'board',
        contentRoute: '/todo?projectId=default-work-items',
      })
      expect(screen.getByTestId('runtime-priority-filter-button')).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    } finally {
      window.removeEventListener(WORKSPACE_NAVIGATION_EVENT, onNavigate)
    }
  })

  test.each(['board', 'priority', 'collapse-read'])(
    'uses the visible task view for %s after opening stand-in from the task board',
    async action => {
      render(<DesktopWorkbenchLayout {...baseProps} />)
      await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
      expect(screen.getByTestId('task-view-board-transition')).toBeInTheDocument()
      await userEvent.click(screen.getByTestId('personal-stand-in-button'))
      expect(screen.getByTestId('personal-stand-in-button')).toHaveAttribute('aria-current', 'page')
      expect(screen.queryByTestId('task-view-board-transition')).not.toBeInTheDocument()
      expect(screen.getByTestId('runtime-priority-filter-button')).toHaveAttribute(
        'aria-pressed',
        'false'
      )

      const onNavigate = vi.fn((event: Event) => event.preventDefault())
      window.addEventListener(WORKSPACE_NAVIGATION_EVENT, onNavigate)
      try {
        await userEvent.click(screen.getByTestId('runtime-task-view-menu-button'))
        await userEvent.click(screen.getByTestId(`runtime-task-view-${action}`))
        if (action === 'board') {
          expect(onNavigate).toHaveBeenCalledTimes(1)
          expect((onNavigate.mock.calls[0][0] as CustomEvent).detail).toEqual({
            kind: 'board',
            contentRoute: '/todo?projectId=default-work-items',
          })
        } else {
          expect(onNavigate).not.toHaveBeenCalled()
          expect(window.location.pathname).toBe('/stand-in')
        }
      } finally {
        window.removeEventListener(WORKSPACE_NAVIGATION_EVENT, onNavigate)
      }
    }
  )

  test('opens a direct stand-in route while experimental features are disabled', async () => {
    experimentalFeatures.enabled = false
    deliveryApiMock.available = true
    const original = window.location.href
    try {
      window.history.replaceState({}, '', '/stand-in?profileId=default')
      await act(async () => {
        render(
          <DesktopWorkbenchLayout
            {...baseProps}
            runtimeTaskReminders={EMPTY_RUNTIME_TASK_REMINDERS}
          />
        )
      })
      expect(screen.getByTestId('personal-stand-in-workspace')).toBeInTheDocument()
      expect(screen.getByTestId('personal-stand-in-button')).toHaveAttribute('aria-current', 'page')
      expect(screen.getByTestId('personal-stand-in-beta')).toHaveTextContent('Beta')
    } finally {
      window.history.replaceState({}, '', original)
    }
  })

  test('shows only the local runtime selector in the task composer', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('workbench-harness-selector')).toHaveTextContent('Codex')
    expect(screen.queryByTestId('workbench-team-selector')).not.toBeInTheDocument()
  })

  test('hides cloud project space entries in the @ menu while experimental features are disabled', async () => {
    experimentalFeatures.enabled = false
    deliveryApiMock.available = true

    render(<DesktopWorkbenchLayout {...baseProps} />)

    const editor = (await screen.findByTestId('chat-message-input')) as HTMLElement & {
      value: string
    }
    act(() => {
      editor.value = '@'
      editor.focus()
    })

    expect(await screen.findByTestId('mention-files-action')).toBeInTheDocument()
    expect(screen.queryByTestId('mention-cloud-space-direct-action')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mention-cloud-projects-action')).not.toBeInTheDocument()
  })

  test('shows the work-item composer guide while experimental features are disabled', async () => {
    experimentalFeatures.enabled = false
    deliveryApiMock.available = true
    deliveryApiMock.listCloudProjects.mockResolvedValue({
      items: [
        {
          id: 'default-work-items',
          public_id: 'default-work-items',
          project_key: 'WORK',
          name: '我的任务',
          description: '',
          project_store: 'local',
          task_provider: 'local',
          provider_config: {},
          created_by_user_id: 1,
          status: 'active',
          tags: [],
          version: 1,
          created_at: '2026-08-09T00:00:00Z',
          updated_at: '2026-08-09T00:00:00Z',
          metadata: { system_kind: 'default_work_items' },
        },
      ],
    })

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(await screen.findByTestId('project-space-context-pill')).toHaveTextContent('我的任务')
  })

  test('restores delivery context when an opened runtime task is absent from runtime work', async () => {
    experimentalFeatures.enabled = false
    deliveryApiMock.available = true
    deliveryApiMock.runtimePortAvailable = true
    const project = {
      id: 'project-1',
      public_id: 'public-project-1',
      project_key: 'PROJECT',
      name: 'Dispatch project',
      description: '',
      project_store: 'backend',
      task_provider: 'local',
      provider_config: {},
      created_by_user_id: 1,
      status: 'active',
      tags: [],
      version: 1,
      created_at: '2026-09-24T00:00:00Z',
      updated_at: '2026-09-24T00:00:00Z',
    }
    const issue = {
      id: 'PROJECT-2',
      cloud_project_id: project.id,
      sequence_number: 2,
      parent_id: 'PROJECT-1',
      root_item_id: 'PROJECT-1',
      title: '汇总三条反馈',
      description: '汇总三条反馈并提交可核验交付。',
      status: 'in_progress',
      priority: 'medium',
      assignee_user_id: 1,
      tags: [],
      sort_order: 0,
      version: 2,
      created_at: '2026-09-24T00:00:00Z',
      updated_at: '2026-09-24T00:00:00Z',
    }
    const runtimeTask = {
      deviceId: 'device-1',
      taskId: 'runtime-1',
    }
    deliveryApiMock.findRuntimeContext.mockResolvedValue({
      project,
      issueId: issue.id,
    })
    deliveryApiMock.findRuntimeIssue.mockResolvedValue(issue)

    const { rerender } = render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          user: {
            id: 1,
            user_name: 'local',
            email: 'local@example.com',
          },
          currentRuntimeTask: runtimeTask,
          runtimeWork: {
            projects: [],
            chats: [],
            totalTasks: 0,
          },
        }}
      />
    )

    await waitFor(() =>
      expect(deliveryApiMock.findRuntimeContext).toHaveBeenCalledWith(runtimeTask)
    )
    expect(deliveryApiMock.findRuntimeIssue).toHaveBeenCalledWith(runtimeTask)
    expect(screen.getByTestId('chat-message-input')).toBeInTheDocument()
    expect(screen.queryByTestId('project-execution-reply-in-issue')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('environment-info-button'))
    expect(await screen.findByTestId('environment-delivery-button')).toHaveTextContent('交付')

    rerender(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          user: {
            id: 1,
            user_name: 'local',
            email: 'local@example.com',
          },
          currentRuntimeTask: {
            ...runtimeTask,
            issueExecution: {
              projectId: project.id,
              issueId: issue.id,
            },
            projectSession: {
              projectId: project.id,
              issueId: issue.id,
            },
          },
          runtimeWork: {
            projects: [],
            chats: [],
            totalTasks: 0,
          },
        }}
      />
    )

    expect(await screen.findByTestId('project-execution-reply-in-issue')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-message-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('fork-runtime-task-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('continue-in-im-button')).not.toBeInTheDocument()
  })

  test('searches the sole project workspace from a new chat with multiple device workspaces', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    const runtimeWork = createRuntimeWorkForProject(workspacePanelState.currentProject)!
    runtimeWork.chats = [
      {
        deviceId: 'workspace-cloud-device',
        available: true,
        workspacePath: '/workspace/other-chat-a',
        tasks: [],
      },
      {
        deviceId: 'workspace-cloud-device',
        available: true,
        workspacePath: '/workspace/other-chat-b',
        tasks: [],
      },
    ]
    const searchWorkspaceEntries = vi.fn().mockResolvedValue({
      files: [
        {
          root: '/workspace/project',
          path: 'cloud-context-folder',
          fileName: 'cloud-context-folder',
          matchType: 'directory' as const,
          score: 100,
          indices: [0, 1, 2, 3, 4],
        },
      ],
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          ...baseProps.workspaceFileApi,
          searchWorkspaceEntries,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
          runtimeWork,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    const editor = (await screen.findByTestId('chat-message-input')) as HTMLElement & {
      value: string
    }
    act(() => {
      editor.value = '@cloud-context-folder'
      editor.focus()
    })

    expect(await screen.findByTestId('workspace-mention-option-0')).toBeInTheDocument()
    expect(searchWorkspaceEntries).toHaveBeenCalledWith(
      'workspace-cloud-device',
      '/workspace/project',
      'cloud-context-folder',
      expect.any(String)
    )
  })

  test('rechecks project spaces when a retained task workbench becomes visible again', async () => {
    deliveryApiMock.available = true
    deliveryApiMock.listCloudProjects.mockResolvedValue({ items: [] })
    const currentProject = activeProjectState.currentProject
    const runtimeWork = structuredClone(createRuntimeWorkForProject(currentProject)!)
    runtimeWork.projects[0].project.defaultProjectSpace = {
      projectStore: 'local',
      projectId: 'space-1',
    }
    const props = {
      ...baseProps,
      state: {
        ...activeProjectState,
        runtimeWork,
      },
      projectWork: {
        ...baseProps.projectWork,
        currentProject,
        currentProjectId: currentProject.id,
        runtimeWork,
      },
    }
    const { rerender } = render(<DesktopWorkbenchLayout {...props} />)

    await waitFor(() => expect(deliveryApiMock.listCloudProjects).toHaveBeenCalledOnce())

    rerender(<DesktopWorkbenchLayout {...props} routeActive={false} />)
    deliveryApiMock.listCloudProjects.mockResolvedValue({
      items: [
        {
          id: 'space-1',
          public_id: 'public-space-1',
          project_key: 'SPACE-1',
          name: 'Task Follow-up Board',
          description: '',
          project_store: 'local',
          task_provider: 'local',
          provider_config: {},
          created_by_user_id: 1,
          status: 'active',
          tags: [],
          version: 1,
          created_at: '2026-08-09T00:00:00Z',
          updated_at: '2026-08-09T00:00:00Z',
        },
      ],
    })
    rerender(<DesktopWorkbenchLayout {...props} />)

    await waitFor(() => expect(deliveryApiMock.listCloudProjects).toHaveBeenCalledTimes(2))
  })

  test.each([
    { forkError: null, selectedModel: harnessTestModel },
    { forkError: 'Fork service unavailable', selectedModel: harnessTestModel },
    { forkError: null, selectedModel: null },
  ])(
    'forks an earlier completed turn without stopping the running follow-up (%j)',
    async ({ forkError, selectedModel }) => {
      const currentRuntimeTask = {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-1',
      }
      const onCancelRuntimePaneTask = vi.fn().mockResolvedValue(true)
      const onForkCurrentRuntimeTask = forkError
        ? vi.fn().mockRejectedValue(new Error(forkError))
        : vi.fn().mockResolvedValue(undefined)

      render(
        <DesktopWorkbenchLayout
          {...baseProps}
          state={{
            ...baseProps.state,
            currentRuntimeTask,
          }}
          lifecycleTaskRunning
          messages={[
            {
              id: 'assistant-turn-1',
              role: 'assistant',
              content: 'First turn complete',
              status: 'done',
              turnId: 'turn-1',
              createdAt: '2026-07-25T12:00:00.000Z',
            },
            {
              id: 'assistant-turn-2',
              role: 'assistant',
              content: 'Follow-up is streaming',
              status: 'streaming',
              turnId: 'turn-2',
              createdAt: '2026-07-25T12:01:00.000Z',
            },
          ]}
          projectChat={{
            ...baseProps.projectChat,
            models: [harnessTestModel],
            selectedModel,
            selectedModelOptions: { reasoning_effort: 'high' },
          }}
          onCancelRuntimePaneTask={onCancelRuntimePaneTask}
          onForkCurrentRuntimeTask={onForkCurrentRuntimeTask}
        />
      )

      await userEvent.click(screen.getByTestId('fork-message-button'))

      expect(onCancelRuntimePaneTask).not.toHaveBeenCalled()
      expect(onForkCurrentRuntimeTask).toHaveBeenCalledWith(
        {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
        },
        {
          source: currentRuntimeTask,
          lastTurnId: 'turn-1',
          ...(selectedModel
            ? {
                modelSelection: {
                  modelName: 'local-model:test',
                  modelType: 'runtime',
                  options: {
                    collaborationMode: 'default',
                    reasoning_effort: 'high',
                  },
                },
              }
            : {}),
        }
      )
      const paneSession = paneSessionMockRef.current as { setError: ReturnType<typeof vi.fn> }
      if (forkError) {
        await waitFor(() => expect(paneSession.setError).toHaveBeenCalledWith(forkError))
      } else {
        expect(paneSession.setError).not.toHaveBeenCalled()
      }
    }
  )

  test('does not publish titlebar actions from an inactive workspace document tab', () => {
    runtimeMocks.electron = true
    render(<DesktopWorkbenchLayout {...baseProps} routeActive={false} />)

    expect(screen.getByTestId('workbench-main-header')).toBeEmptyDOMElement()
    expect(screen.queryByTestId('sidebar-worklists-scroll')).not.toBeInTheDocument()
    expect(screen.queryByTestId('titlebar-main-actions')).not.toBeInTheDocument()
    expect(screen.queryByTestId('titlebar-actions')).not.toBeInTheDocument()
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

  test('shows a dialog when project code-server fails to start', async () => {
    runtimeMocks.electron = true
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

  test('prepares a project worktree before starting the primary OpenCode session', async () => {
    isLocalTerminalAvailableMock.mockReturnValue(true)
    localPathExistsMock.mockResolvedValue(true)
    listLocalHarnessesMock.mockResolvedValue([
      {
        id: 'opencode',
        installed: true,
        executable_path: '/usr/local/bin/opencode',
        version: '1.0.0',
      },
    ])
    const prepareWorktree = vi.fn().mockResolvedValue({
      success: true,
      deviceId: 'device-1',
      path: '/workspace/worktrees/harness-1/github_wegent',
      worktree: {
        deviceId: 'device-1',
        worktreeId: 'harness-1',
        path: '/workspace/worktrees/harness-1/github_wegent',
        repositoryName: 'github_wegent',
        sourcePath: '/workspace/github_wegent',
        state: 'active',
        conversations: [],
      },
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{ ...activeProjectState, input: '在独立工作树中修复问题' }}
        projectChat={{ ...baseProps.projectChat, models: [harnessTestModel] }}
        projectWork={{
          executionMode: 'git_worktree',
          worktreeBranch: 'feature/harness-runtime',
        }}
        runtimeWorkApi={
          { prepareWorktree } as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>
        }
      />
    )

    await waitFor(() => expect(listLocalHarnessesMock).toHaveBeenCalled())
    await userEvent.click(screen.getByTestId('workbench-harness-selector'))
    await userEvent.click(screen.getByTestId('workbench-harness-option-opencode'))

    const input = screen.getByTestId('chat-message-input')
    const form = input.closest('form')
    if (!form) throw new Error('Workbench composer form was not rendered')
    fireEvent.submit(form)

    await waitFor(() =>
      expect(prepareWorktree).toHaveBeenCalledWith({
        deviceId: 'device-1',
        sourcePath: '/workspace/github_wegent',
        worktreeId: expect.stringMatching(/^harness-/),
        ref: 'feature/harness-runtime',
      })
    )
    await waitFor(() =>
      expect(startLocalHarnessMock).toHaveBeenCalledWith(
        expect.objectContaining({
          harnessId: 'opencode',
          prompt: '在独立工作树中修复问题',
          isPrimary: true,
          projectId: 1,
          cwd: '/workspace/worktrees/harness-1/github_wegent',
        })
      )
    )
    expect(screen.getByTestId('project-local-tasks-panel-1')).toContainElement(
      await screen.findByTestId('local-harness-session-row-local-harness-1')
    )
  }, 15_000)

  test('reopens the loaded Codex task when switching back from another page', async () => {
    window.history.pushState({}, '', '/automations')
    const currentRuntimeTask = {
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      taskId: 'runtime-loaded',
    }
    const onOpenRuntimeTask = vi.fn().mockResolvedValue(undefined)

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
                workspaceKind: 'chat',
                available: true,
                tasks: [
                  {
                    taskId: 'runtime-loaded',
                    workspacePath: '/workspace/project-alpha',
                    title: 'Codex 会话',
                    runtime: 'codex',
                    createdAt: '2026-08-11T00:00:00.000Z',
                    updatedAt: '2026-08-11T00:00:00.000Z',
                    running: false,
                  },
                ],
              },
            ],
            totalTasks: 1,
          },
          currentRuntimeTask,
        }}
        onOpenRuntimeTask={onOpenRuntimeTask}
      />
    )

    await userEvent.click(screen.getByTestId('runtime-local-task-row-runtime-loaded'))

    expect(onOpenRuntimeTask).toHaveBeenCalledOnce()
    expect(onOpenRuntimeTask).toHaveBeenCalledWith(currentRuntimeTask)
  })

  test('resumes an inactive persisted harness session with the same Wework session id', async () => {
    isLocalTerminalAvailableMock.mockReturnValue(true)
    localPathExistsMock.mockResolvedValue(true)
    const listLocalSkills = vi.fn().mockRejectedValue(new Error('must not reload plugins'))
    listLocalHarnessesMock.mockResolvedValue([
      {
        id: 'opencode',
        installed: true,
        executable_path: '/usr/local/bin/opencode',
        version: '1.18.16',
      },
    ])
    listLocalHarnessSessionsMock.mockResolvedValue([
      {
        session_id: 'local-harness-persisted',
        harness_id: 'opencode',
        title: '重启后继续修复',
        cwd: '/workspace/github_wegent',
        created_at: 1234,
        is_primary: true,
        project_id: 1,
        active: false,
        model_key: harnessTestModel.key,
        plugin_roots: ['/Users/test/.wework/plugins/github/1.0.0'],
      },
    ])
    startLocalHarnessMock.mockResolvedValue('local-harness-persisted')

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        projectChat={{ ...baseProps.projectChat, models: [harnessTestModel], listLocalSkills }}
      />
    )

    const sessionRow = await screen.findByTestId(
      'local-harness-session-row-local-harness-persisted'
    )
    expect(sessionRow).toHaveTextContent('重启后继续修复')
    expect(startLocalHarnessMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('desktop-empty-composer-frame')).toBeInTheDocument()

    await userEvent.click(sessionRow)

    await waitFor(() =>
      expect(startLocalHarnessMock).toHaveBeenCalledWith({
        harnessId: 'opencode',
        prompt: '',
        isPrimary: true,
        projectId: 1,
        cwd: '/workspace/github_wegent',
        executablePath: null,
        args: [],
        pluginRoots: ['/Users/test/.wework/plugins/github/1.0.0'],
        proxyToken: undefined,
        modelKey: null,
        resumeSessionId: 'local-harness-persisted',
        env: {
          WEWORK_EMBEDDED_BROWSER_LABEL: 'workspace-browser-blank-0',
        },
      })
    )
    expect(resolveLocalHarnessLaunchMock).not.toHaveBeenCalled()
    expect(listLocalSkills).not.toHaveBeenCalled()
    expect(await screen.findByTestId('central-harness-terminal')).toBeVisible()
    expect(screen.getByTestId('embedded-local-terminal')).toHaveAttribute(
      'data-session-id',
      'local-harness-persisted'
    )
    expect(screen.getByTestId('workbench-pane-task-title')).toHaveTextContent('重启后继续修复')

    act(() => localTerminalExitCallbacks.get('local-harness-persisted')!())

    expect(screen.getByTestId('central-harness-terminal')).toBeVisible()
    expect(screen.queryByTestId('local-harness-session-resuming')).not.toBeInTheDocument()
    expect(startLocalHarnessMock).toHaveBeenCalledTimes(1)
  })

  test('resumes a persisted OpenCode session across model refreshes during workspace and launch checks', async () => {
    isLocalTerminalAvailableMock.mockReturnValue(true)
    const workspaceCheck = createDeferred<boolean>()
    localPathExistsMock.mockReturnValue(workspaceCheck.promise)
    listLocalHarnessesMock.mockResolvedValue([
      {
        id: 'opencode',
        installed: true,
        executable_path: '/usr/local/bin/opencode',
        version: '1.18.16',
      },
    ])
    listLocalHarnessSessionsMock.mockResolvedValue([
      {
        session_id: 'local-harness-model-loading',
        harness_id: 'opencode',
        title: '等待模型加载',
        cwd: '/workspace/persisted-model-refresh',
        created_at: 1234,
        is_primary: true,
        project_id: 1,
        active: false,
        model_key: 'wework:runtime:::local-model%3Atest',
        plugin_roots: [],
      },
    ])
    const harnessLaunch = createDeferred<string>()
    startLocalHarnessMock.mockReturnValue(harnessLaunch.promise)

    const { rerender } = render(
      <DesktopWorkbenchLayout
        {...baseProps}
        projectChat={{
          ...baseProps.projectChat,
          models: [],
          isModelSelectionReady: false,
        }}
      />
    )

    const sessionRow = await screen.findByTestId(
      'local-harness-session-row-local-harness-model-loading'
    )
    expect(sessionRow).toHaveTextContent('等待模型加载')
    expect(screen.getByTestId('desktop-empty-composer-frame')).toBeInTheDocument()
    expect(screen.queryByTestId('local-harness-session-resuming')).not.toBeInTheDocument()
    expect(startLocalHarnessMock).not.toHaveBeenCalled()

    await userEvent.click(sessionRow)

    expect(screen.getByTestId('local-harness-session-resuming')).toHaveTextContent(
      '正在恢复 OpenCode 会话'
    )
    expect(screen.getByTestId('local-harness-session-resuming')).not.toHaveTextContent(
      '请选择可用的 Wework 模型'
    )
    expect(startLocalHarnessMock).not.toHaveBeenCalled()

    localPathExistsMock.mockClear()
    rerender(
      <DesktopWorkbenchLayout
        {...baseProps}
        projectChat={{
          ...baseProps.projectChat,
          models: [harnessTestModel],
          isModelSelectionReady: true,
        }}
      />
    )

    await waitFor(() =>
      expect(localPathExistsMock).toHaveBeenCalledWith('/workspace/persisted-model-refresh')
    )
    rerender(
      <DesktopWorkbenchLayout
        {...baseProps}
        projectChat={{
          ...baseProps.projectChat,
          models: [{ ...harnessTestModel }],
          isModelSelectionReady: true,
        }}
      />
    )
    await act(async () => workspaceCheck.resolve(true))

    await waitFor(() =>
      expect(resolveLocalHarnessLaunchMock).toHaveBeenCalledWith(
        'opencode',
        expect.objectContaining({ label: 'Test Model' })
      )
    )
    await waitFor(() =>
      expect(startLocalHarnessMock).toHaveBeenCalledWith(
        expect.objectContaining({
          harnessId: 'opencode',
          cwd: '/workspace/persisted-model-refresh',
          modelKey: 'wework:runtime:::local-model%3Atest',
          resumeSessionId: 'local-harness-model-loading',
        })
      )
    )
    rerender(
      <DesktopWorkbenchLayout
        {...baseProps}
        projectChat={{
          ...baseProps.projectChat,
          models: [{ ...harnessTestModel }],
          isModelSelectionReady: true,
        }}
      />
    )
    await act(async () => harnessLaunch.resolve('local-harness-model-loading'))
    expect(resolveLocalHarnessLaunchMock).toHaveBeenCalledTimes(1)
    expect(startLocalHarnessMock).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId('central-harness-terminal')).toBeVisible()
  })

  test('shows one resume error instead of retrying a missing OpenCode workspace forever', async () => {
    isLocalTerminalAvailableMock.mockReturnValue(true)
    listLocalHarnessesMock.mockResolvedValue([
      {
        id: 'opencode',
        installed: true,
        executable_path: '/usr/local/bin/opencode',
        version: '1.18.16',
      },
    ])
    listLocalHarnessSessionsMock.mockResolvedValue([
      {
        session_id: 'local-harness-missing-workspace',
        harness_id: 'opencode',
        title: '工作区已删除',
        cwd: '/workspace/deleted-worktree',
        created_at: 1234,
        is_primary: true,
        project_id: null,
        active: false,
        model_key: null,
        plugin_roots: [],
      },
    ])
    localPathExistsMock.mockResolvedValue(false)

    const { rerender } = render(<DesktopWorkbenchLayout {...baseProps} />)

    const sessionRow = await screen.findByTestId(
      'local-harness-session-row-local-harness-missing-workspace'
    )
    expect(sessionRow).toHaveTextContent('工作区已删除')
    expect(localPathExistsMock).not.toHaveBeenCalledWith('/workspace/deleted-worktree')
    expect(screen.getByTestId('desktop-empty-composer-frame')).toBeInTheDocument()

    await userEvent.click(sessionRow)

    await waitFor(() =>
      expect(screen.getByTestId('local-harness-session-resuming')).toHaveTextContent(
        '原工作区不存在，无法恢复会话：/workspace/deleted-worktree'
      )
    )
    const missingWorkspaceChecks = () =>
      localPathExistsMock.mock.calls.filter(([path]) => path === '/workspace/deleted-worktree')
        .length
    const checksAfterError = missingWorkspaceChecks()
    expect(checksAfterError).toBeGreaterThan(0)
    expect(startLocalHarnessMock).not.toHaveBeenCalled()

    await act(async () => {
      rerender(<DesktopWorkbenchLayout {...baseProps} />)
    })
    expect(missingWorkspaceChecks()).toBe(checksAfterError)
    expect(startLocalHarnessMock).not.toHaveBeenCalled()
  })

  test('starts Claude Code without overriding its native model by default', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    isLocalTerminalAvailableMock.mockReturnValue(true)
    listLocalHarnessesMock.mockResolvedValue([
      {
        id: 'claude_code',
        installed: true,
        executable_path: '/usr/local/bin/claude',
        version: '2.1.0',
      },
    ])

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...activeProjectState,
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
          input: '分析并修复测试失败',
        }}
        projectChat={{ ...baseProps.projectChat, models: [harnessTestModel] }}
        onSend={onSend}
      />
    )

    await waitFor(() => expect(listLocalHarnessesMock).toHaveBeenCalled())
    await userEvent.click(screen.getByTestId('workbench-harness-selector'))
    const claudeCodeOption = screen.getByTestId('workbench-harness-option-claude_code')
    await waitFor(() => expect(claudeCodeOption).not.toBeDisabled())
    await userEvent.click(claudeCodeOption)
    expect(screen.getByTestId('workbench-harness-selector')).toHaveTextContent('Claude Code')
    expect(screen.getByTestId('workbench-harness-model-selector')).toHaveTextContent('不指定模型')

    const input = screen.getByTestId('chat-message-input')
    const form = input.closest('form')
    if (!form) throw new Error('Workbench composer form was not rendered')
    fireEvent.submit(form)

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        '分析并修复测试失败',
        expect.objectContaining({
          runtime: 'claude_code',
          runtimeExecutablePath: '/usr/local/bin/claude',
          modelSelection: null,
        })
      )
    )
    expect(startLocalHarnessMock).not.toHaveBeenCalled()
    expect(resolveLocalHarnessLaunchMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('central-harness-terminal')).not.toBeInTheDocument()
  })

  test('starts OpenCode from the Wework dev workspace without selecting a project', async () => {
    vi.stubEnv('VITE_WEWORK_DEV_TITLE', 'OpenCode harness development')
    vi.stubEnv('VITE_WEWORK_DEV_WORKTREE', '/workspace/current-wework')
    isLocalTerminalAvailableMock.mockReturnValue(true)
    listLocalHarnessesMock.mockResolvedValue([
      {
        id: 'opencode',
        installed: true,
        executable_path: '/usr/local/bin/opencode',
        version: '1.0.0',
      },
    ])

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{ ...baseProps.state, input: '检查当前工作区' }}
        projectChat={{ ...baseProps.projectChat, models: [harnessTestModel] }}
      />
    )

    await waitFor(() => expect(listLocalHarnessesMock).toHaveBeenCalled())
    await userEvent.click(screen.getByTestId('workbench-harness-selector'))
    const openCodeOption = screen.getByTestId('workbench-harness-option-opencode')
    await waitFor(() => expect(openCodeOption).not.toBeDisabled())
    await userEvent.click(openCodeOption)

    const input = screen.getByTestId('chat-message-input')
    const form = input.closest('form')
    if (!form) throw new Error('Workbench composer form was not rendered')
    fireEvent.submit(form)

    await waitFor(() =>
      expect(startLocalHarnessMock).toHaveBeenCalledWith({
        harnessId: 'opencode',
        prompt: '检查当前工作区',
        isPrimary: true,
        projectId: null,
        cwd: '/workspace/current-wework',
        executablePath: null,
        args: [],
        pluginRoots: [],
        proxyToken: undefined,
        modelKey: null,
        resumeSessionId: undefined,
        env: {
          WEWORK_EMBEDDED_BROWSER_LABEL: 'workspace-browser-blank-0',
        },
      })
    )
    expect(resolveLocalHarnessLaunchMock).not.toHaveBeenCalled()

    expect(screen.getByTestId('local-harness-session-row-local-harness-1')).toBeInTheDocument()
    expect(screen.getByTestId('central-harness-terminal')).toBeVisible()

    await userEvent.click(screen.getByTestId('new-chat-button'))

    expect(closeLocalTerminalMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('desktop-empty-composer-frame')).toBeInTheDocument()
    expect(screen.queryByTestId('central-harness-terminal')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('local-harness-session-row-local-harness-1'))

    await waitFor(() => expect(screen.getByTestId('central-harness-terminal')).toBeVisible())

    expect(screen.queryByTestId('central-harness-close-button')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('central-harness-archive-button'))

    await waitFor(() =>
      expect(archiveLocalHarnessSessionMock).toHaveBeenCalledWith('local-harness-1')
    )
    expect(
      screen.queryByTestId('local-harness-session-row-local-harness-1')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('desktop-empty-composer-frame')).toBeInTheDocument()
  })

  test.each(['offline'] as const)(
    'keeps project creation and the composer mounted when a %s historical runtime shares the current IPC address',
    async status => {
      const identity = {
        deviceId: 'current-app-ipc',
        runtimeInstanceId: 'current-runtime',
        provenance: 'local-ipc' as const,
      }
      const localDevice = qualifyLocalRuntimeSource(
        {
          ...createLocalSkillDevice(),
          device_id: identity.deviceId,
          runtime_instance_id: identity.runtimeInstanceId,
        },
        identity
      )
      const state = {
        ...baseProps.state,
        standaloneDeviceId: identity.deviceId,
        devices: [localDevice],
      }
      const view = render(<DesktopWorkbenchLayout {...baseProps} state={state} />)
      expect(screen.getByTestId('projects-create-button')).toBeInTheDocument()

      view.rerender(
        <DesktopWorkbenchLayout
          {...baseProps}
          state={{
            ...state,
            devices: [
              {
                ...localDevice,
                id: 77,
                name: 'Historical remote alias',
                device_type: 'remote',
                is_default: false,
                status,
                runtime_instance_id: 'historical-runtime',
              },
              localDevice,
            ],
          }}
        />
      )

      expect(screen.getByTestId('desktop-empty-composer-frame')).toBeInTheDocument()
      await userEvent.click(screen.getByTestId('projects-create-button'))
      expect(screen.getByTestId('project-create-remote-option')).toBeInTheDocument()
    }
  )

  test('remote project dialog shows a version-mismatched Docker device as disabled', async () => {
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
              device_id: 'remote-device',
              name: 'Remote Docker Device',
              status: 'online',
              is_default: false,
              device_type: 'remote',
              bind_shell: 'claudecode',
              executor_version: 'dev',
              client_ip: '10.201.3.201',
              slot_used: 0,
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-folder-no-device')).toHaveTextContent('添加设备')
    expect(screen.getByTestId('standalone-folder-no-device')).toHaveTextContent('远程 Docker 设备')
    expect(screen.getByTestId('standalone-remote-device-select')).toHaveTextContent(
      'Remote Docker Device'
    )
    expect(screen.getByTestId('standalone-remote-device-select')).toHaveTextContent('10.201.3.201')
    expect(screen.getByTestId('standalone-remote-device-select')).toHaveTextContent(
      '需升级到 v1.8.5'
    )
    expect(screen.getByTestId('standalone-remote-device-option-remote-device')).toBeDisabled()
    expect(screen.getByTestId('standalone-remote-device-unavailable-hint')).toHaveTextContent(
      '版本不匹配'
    )
    expect(onUpgradeDevice).not.toHaveBeenCalled()
  })

  test('remote project dialog excludes remote routes that belong to the local runtime', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'remote-device',
              name: 'Remote Device',
              status: 'online',
              is_default: false,
              device_type: 'remote',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
              runtime_instance_id: 'runtime-local',
              runtime_routes: [
                {
                  kind: 'app-ipc',
                  device_id: 'app-device',
                  runtime_device_id: 'app-device',
                  device_type: 'app',
                  name: 'Local Executor',
                  status: 'online',
                },
                {
                  kind: 'remote-relay',
                  device_id: 'remote-device',
                  runtime_device_id: 'remote-device',
                  device_type: 'remote',
                  name: 'Remote Device',
                  status: 'online',
                },
              ],
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-folder-no-device')).toHaveTextContent('添加设备')
    expect(screen.queryByTestId('standalone-remote-device-select')).not.toBeInTheDocument()
    expect(screen.queryByText('Remote Device')).not.toBeInTheDocument()
  })

  test('creates a project from a collaboration composer without navigating to the task surface', async () => {
    const onOpenStandaloneWorkspace = vi.fn()
    const onCreated = vi.fn()
    const createdProject = {
      id: 93,
      name: 'Product',
      config: {
        mode: 'workspace' as const,
        execution: { targetType: 'local' as const, deviceId: 'device-1' },
        workspace: { source: 'local_path' as const, localPath: '/Users/alice/repo' },
      },
      tasks: [],
    }
    const onCreateLocalRuntimeProject = vi.fn().mockResolvedValue(createdProject)
    nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker.mockResolvedValue(
      '/Users/alice/repo'
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        surfaceKind="board"
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
        onCreateLocalRuntimeProject={onCreateLocalRuntimeProject}
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
              device_type: 'local',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    act(() => {
      requestProjectCreateMode('existing', {
        preserveCurrentSurface: true,
        onCreated,
      })
    })

    expect(await screen.findByTestId('local-project-create-dialog')).toBeInTheDocument()
    await userEvent.clear(screen.getByTestId('local-project-create-name-input'))
    await userEvent.type(screen.getByTestId('local-project-create-name-input'), 'Product')
    await userEvent.click(screen.getByTestId('confirm-local-project-create-button'))

    await waitFor(() =>
      expect(onCreateLocalRuntimeProject).toHaveBeenCalledWith({
        deviceId: 'device-1',
        name: 'Product',
        roots: ['/Users/alice/repo'],
      })
    )
    expect(onCreated).toHaveBeenCalledWith(createdProject)
    expect(onOpenStandaloneWorkspace).not.toHaveBeenCalled()
    expect(screen.getByTestId('cloud-board-loading')).toBeInTheDocument()
  })

  test('keeps the native folder picker active while callback identities change', async () => {
    const onOpenStandaloneWorkspace = vi.fn()
    let resolvePicker: (path: string) => void = () => undefined
    nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker.mockImplementation(
      () =>
        new Promise(resolve => {
          resolvePicker = resolve
        })
    )
    const props = {
      ...baseProps,
      state: {
        ...baseProps.state,
        devices: [
          {
            id: 1,
            device_id: 'device-1',
            name: 'sifang-executor',
            status: 'online' as const,
            is_default: true,
            bind_shell: 'claudecode' as const,
            device_type: 'local' as const,
            executor_version: '1.8.5',
          },
        ],
      },
    }
    const view = render(
      <DesktopWorkbenchLayout
        {...props}
        onOpenStandaloneWorkspace={(deviceId, workspacePath) =>
          onOpenStandaloneWorkspace(deviceId, workspacePath)
        }
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-local-option'))
    await waitFor(() =>
      expect(nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker).toHaveBeenCalledTimes(1)
    )

    view.rerender(
      <DesktopWorkbenchLayout
        {...props}
        onOpenStandaloneWorkspace={(deviceId, workspacePath) =>
          onOpenStandaloneWorkspace(deviceId, workspacePath)
        }
      />
    )
    resolvePicker('/Users/alice/repo')

    expect(await screen.findByTestId('local-project-create-dialog')).toBeInTheDocument()
    expect(onOpenStandaloneWorkspace).not.toHaveBeenCalled()
  })

  test('does not open the in-app folder dialog when the native folder picker is cancelled', async () => {
    const onOpenStandaloneWorkspace = vi.fn()
    nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker.mockResolvedValue(null)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
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
              device_type: 'local',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-local-option'))

    await waitFor(() =>
      expect(nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker).toHaveBeenCalledTimes(1)
    )
    expect(onOpenStandaloneWorkspace).not.toHaveBeenCalled()
    expect(screen.queryByTestId('standalone-folder-project-dialog')).not.toBeInTheDocument()
  })

  test('creates a blank remote project directory before opening it', async () => {
    const onGetDeviceHomeDirectory = vi.fn().mockResolvedValue('/home/ubuntu')
    const onListDeviceDirectories = vi.fn().mockResolvedValue([])
    const onCreateDeviceDirectory = vi.fn().mockResolvedValue(undefined)
    const onOpenStandaloneWorkspace = vi.fn().mockResolvedValue(undefined)

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
              device_id: 'device-1',
              name: 'Remote device',
              status: 'online',
              is_default: true,
              bind_shell: 'claudecode',
              device_type: 'remote',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))
    expect(screen.getByTestId('remote-project-source-options')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('remote-project-source-blank'))
    await waitFor(() => expect(onGetDeviceHomeDirectory).toHaveBeenCalledWith('device-1'))
    await userEvent.type(screen.getByTestId('device-folder-name-input'), 'new-project')
    await userEvent.click(screen.getByTestId('confirm-device-folder-picker-button'))

    await waitFor(() =>
      expect(onCreateDeviceDirectory).toHaveBeenCalledWith('device-1', '/home/ubuntu/new-project')
    )
    await waitFor(() =>
      expect(onOpenStandaloneWorkspace).toHaveBeenCalledWith(
        'device-1',
        '/home/ubuntu/new-project',
        'new-project'
      )
    )
  }, 15_000)

  test('clones a Git repository before opening the remote project', async () => {
    const onGetDeviceHomeDirectory = vi.fn().mockResolvedValue('/home/ubuntu')
    const onListDeviceDirectories = vi.fn().mockResolvedValue(['projects'])
    const cloneResult = createDeferred<void>()
    const firstOpenResult = createDeferred<void>()
    const onCloneGitRepository = vi.fn().mockReturnValue(cloneResult.promise)
    const onOpenStandaloneWorkspace = vi
      .fn()
      .mockReturnValueOnce(firstOpenResult.promise)
      .mockResolvedValueOnce(undefined)
    const remoteDevice = {
      id: 1,
      device_id: 'device-1',
      name: 'Remote device',
      status: 'online' as const,
      is_default: true,
      bind_shell: 'claudecode',
      device_type: 'remote' as const,
      executor_version: '1.8.5',
    }
    const renderLayout = (device: typeof remoteDevice) => (
      <DesktopWorkbenchLayout
        {...baseProps}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onCloneGitRepository={onCloneGitRepository}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
        state={{
          ...baseProps.state,
          devices: [device],
        }}
      />
    )
    const { rerender } = render(renderLayout(remoteDevice))

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))
    await userEvent.click(screen.getByTestId('remote-project-source-git'))
    await waitFor(() =>
      expect(screen.getByTestId('remote-project-git-parent-input')).toHaveValue('/home/ubuntu')
    )
    await userEvent.click(screen.getByTestId('remote-project-git-parent-browse'))
    await waitFor(() =>
      expect(onListDeviceDirectories).toHaveBeenCalledWith('device-1', '/home/ubuntu')
    )
    await userEvent.click(await screen.findByText('projects'))
    await userEvent.click(screen.getByTestId('confirm-device-folder-picker-button'))
    expect(screen.getByTestId('remote-project-git-parent-input')).toHaveValue(
      '/home/ubuntu/projects'
    )
    rerender(renderLayout({ ...remoteDevice, name: 'Remote device refreshed' }))
    expect(onGetDeviceHomeDirectory).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('remote-project-git-parent-input')).toHaveValue(
      '/home/ubuntu/projects'
    )
    await userEvent.type(
      screen.getByTestId('remote-project-git-url-input'),
      'git@github.com:owner/repository.git'
    )
    await userEvent.click(screen.getByTestId('remote-project-git-advanced-toggle'))
    await userEvent.type(screen.getByTestId('remote-project-git-branch-input'), 'develop')
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('remote-project-git-status')).toHaveTextContent('克隆中')
    expect(screen.queryByTestId('git-clone-project-operations')).not.toBeInTheDocument()
    expect(screen.getByTestId('close-standalone-folder-project-dialog')).toBeDisabled()
    expect(screen.getByTestId('standalone-remote-device-select')).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    expect(onOpenStandaloneWorkspace).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(onCloneGitRepository).toHaveBeenCalledWith('device-1', {
        url: 'git@github.com:owner/repository.git',
        branch: 'develop',
        targetPath: '/home/ubuntu/projects/repository',
      })
    )
    cloneResult.resolve()
    await waitFor(() =>
      expect(onOpenStandaloneWorkspace).toHaveBeenCalledWith(
        'device-1',
        '/home/ubuntu/projects/repository',
        'repository'
      )
    )
    expect(screen.getByTestId('remote-project-git-status')).toHaveTextContent('添加中')
    firstOpenResult.reject(new Error('Failed to register runtime workspace'))
    await waitFor(() =>
      expect(screen.getByTestId('remote-project-git-error')).toHaveTextContent(
        'Failed to register runtime workspace'
      )
    )
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onCloneGitRepository).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onOpenStandaloneWorkspace).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.queryByTestId('standalone-folder-project-dialog')).not.toBeInTheDocument()
    )
  }, 15_000)

  test('refreshes an offline device before retrying a Git clone', async () => {
    const refreshResult = createDeferred<void>()
    const onRefreshDevices = vi.fn().mockReturnValue(refreshResult.promise)
    const onCloneGitRepository = vi
      .fn()
      .mockRejectedValueOnce(new Error('executor-offline:device-1'))
      .mockResolvedValueOnce(undefined)
    const onOpenStandaloneWorkspace = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onRefreshDevices={onRefreshDevices}
        onCloneGitRepository={onCloneGitRepository}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'Remote device',
              status: 'online',
              is_default: true,
              bind_shell: 'claudecode',
              device_type: 'remote',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))
    await userEvent.click(screen.getByTestId('remote-project-source-git'))
    await userEvent.type(
      screen.getByTestId('remote-project-git-url-input'),
      'https://github.com/owner/repository.git'
    )
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))

    await waitFor(
      () =>
        expect(screen.getByTestId('remote-project-git-error')).toHaveTextContent(
          'executor-offline'
        ),
      { timeout: 5_000 }
    )
    const refreshCountBeforeRetry = onRefreshDevices.mock.calls.length
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))

    await waitFor(() => expect(onRefreshDevices).toHaveBeenCalledTimes(refreshCountBeforeRetry + 1))
    expect(onCloneGitRepository).toHaveBeenCalledTimes(1)
    refreshResult.resolve()
    await waitFor(() => expect(onCloneGitRepository).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(onOpenStandaloneWorkspace).toHaveBeenCalledWith(
        'device-1',
        '/home/ubuntu/repository',
        'repository'
      )
    )
    await waitFor(() =>
      expect(screen.queryByTestId('standalone-folder-project-dialog')).not.toBeInTheDocument()
    )
  }, 15_000)

  test.each(['confirm', 'cancel'] as const)(
    'recovers a missing clone executor with an explicit device selection: %s',
    async action => {
      const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {})
      const onCloneGitRepository = vi
        .fn()
        .mockRejectedValueOnce(new Error('executor-not-found:old-device'))
        .mockResolvedValueOnce(undefined)
      const onOpenStandaloneWorkspace = vi.fn().mockResolvedValue(undefined)
      const oldDevice = {
        id: 1,
        device_id: 'old-device',
        name: 'Old remote device',
        status: 'online' as const,
        is_default: true,
        bind_shell: 'claudecode',
        device_type: 'remote' as const,
        executor_version: '1.8.5',
      }
      const renderLayout = (devices: (typeof oldDevice)[]) => (
        <DesktopWorkbenchLayout
          {...baseProps}
          onCloneGitRepository={onCloneGitRepository}
          onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
          state={{ ...baseProps.state, devices }}
        />
      )
      const { rerender } = render(renderLayout([oldDevice]))
      await userEvent.click(screen.getByTestId('projects-create-button'))
      await userEvent.click(screen.getByTestId('project-create-remote-option'))
      await userEvent.click(screen.getByTestId('remote-project-source-git'))
      await waitFor(() =>
        expect(screen.getByTestId('remote-project-git-parent-input')).toHaveValue('/home/ubuntu')
      )
      await userEvent.clear(screen.getByTestId('remote-project-git-parent-input'))
      await userEvent.type(
        screen.getByTestId('remote-project-git-parent-input'),
        '/custom/projects'
      )
      await userEvent.type(
        screen.getByTestId('remote-project-git-url-input'),
        'https://git.example/owner/repository.git'
      )
      await userEvent.click(screen.getByTestId('remote-project-git-advanced-toggle'))
      await userEvent.type(screen.getByTestId('remote-project-git-branch-input'), 'develop')
      await userEvent.click(screen.getByTestId('remote-project-git-submit'))
      await waitFor(() =>
        expect(screen.getByTestId('remote-project-git-error')).toHaveTextContent(
          'executor-not-found'
        )
      )
      expect(
        diagnostic.mock.calls.some(
          ([prefix, entry]) =>
            prefix === '[Wework] Runtime task create diagnostic' &&
            JSON.parse(String(entry)).stage === 'git-project-operation-failed' &&
            JSON.parse(String(entry)).deviceId === 'old-device' &&
            JSON.parse(String(entry)).failureReason === 'executor-not-found'
        )
      ).toBe(true)
      diagnostic.mockRestore()
      const newDevice = { ...oldDevice, id: 2, device_id: 'new-device', name: 'New remote device' }
      rerender(renderLayout([newDevice]))
      await userEvent.click(screen.getByRole('button', { name: '重新选择设备' }))
      await userEvent.selectOptions(
        screen.getByTestId('standalone-remote-device-select'),
        'new-device'
      )
      expect(screen.getByTestId('standalone-remote-device-select')).toHaveValue('new-device')
      expect(screen.getByTestId('remote-project-git-url-input')).toHaveValue(
        'https://git.example/owner/repository.git'
      )
      expect(screen.getByTestId('remote-project-git-parent-input')).toHaveValue('/custom/projects')
      expect(screen.getByTestId('remote-project-git-branch-input')).toHaveValue('develop')
      expect(onCloneGitRepository).toHaveBeenCalledTimes(1)
      expect(onOpenStandaloneWorkspace).not.toHaveBeenCalled()

      if (action === 'cancel') {
        await userEvent.click(screen.getByRole('button', { name: '取消' }))
        expect(screen.queryByTestId('standalone-folder-project-dialog')).not.toBeInTheDocument()
        expect(onCloneGitRepository).toHaveBeenCalledTimes(1)
        return
      }
      await userEvent.click(screen.getByTestId('remote-project-git-submit'))
      await waitFor(() =>
        expect(onCloneGitRepository).toHaveBeenNthCalledWith(2, 'new-device', {
          url: 'https://git.example/owner/repository.git',
          branch: 'develop',
          targetPath: '/custom/projects/repository',
        })
      )
      await waitFor(() =>
        expect(onOpenStandaloneWorkspace).toHaveBeenCalledWith(
          'new-device',
          '/custom/projects/repository',
          'repository'
        )
      )
      await waitFor(() =>
        expect(screen.queryByTestId('standalone-folder-project-dialog')).not.toBeInTheDocument()
      )
    },
    15_000
  )

  test('rejects embedded HTTP Git credentials without cloning', async () => {
    const onCloneGitRepository = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onCloneGitRepository={onCloneGitRepository}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'Remote device',
              status: 'online',
              is_default: true,
              bind_shell: 'claudecode',
              device_type: 'remote',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))
    await userEvent.click(screen.getByTestId('remote-project-source-git'))
    fireEvent.change(screen.getByTestId('remote-project-git-url-input'), {
      target: { value: 'https://token@github.com/owner/repository.git' },
    })
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))

    expect(await screen.findByTestId('remote-project-git-error')).toHaveTextContent(
      '仓库地址不能包含账号、密码或 Token'
    )
    expect(onCloneGitRepository).not.toHaveBeenCalled()

    fireEvent.change(screen.getByTestId('remote-project-git-url-input'), {
      target: { value: 'https://user:password@github.com/owner/repository.git' },
    })
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))

    expect(await screen.findByTestId('remote-project-git-error')).toHaveTextContent(
      '仓库地址不能包含账号、密码或 Token'
    )
    expect(onCloneGitRepository).not.toHaveBeenCalled()
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
      client_ip: '10.201.3.200',
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
      '10.201.3.200 已离线，恢复在线后可继续对话'
    )
    expect(screen.queryByTestId('composer-disabled-reason')).not.toBeInTheDocument()
    expect(screen.queryByTestId('device-status-prompt')).not.toBeInTheDocument()
    expect(screen.getByTestId('send-message-button')).toBeDisabled()

    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(baseProps.onSend).not.toHaveBeenCalled()
  })

  test('restores the environment after closing subagents while another tab remains', async () => {
    const loadRuntimeTranscriptForPane = vi.fn().mockResolvedValue({
      messages: [
        {
          id: 'restored-child-assistant',
          role: 'assistant',
          content: 'Loaded from the persisted child thread',
          status: 'done',
          createdAt: '2026-09-10T08:00:01.000Z',
        },
      ],
    })
    renderWorkspacePanelLayout({
      mainWidth: 1000,
      currentRuntimeTask: {
        deviceId: 'workspace-cloud-device',
        taskId: 'runtime-subagent-panel',
        workspacePath: '/workspace/project',
      },
      onLoadRuntimeTranscriptForPane: loadRuntimeTranscriptForPane,
      messages: [
        {
          id: 'assistant-with-subagent',
          role: 'assistant',
          content: '',
          status: 'done',
          createdAt: '2026-09-10T08:00:00.000Z',
          blocks: [
            {
              id: 'subagent-thread-1',
              subtaskId: 'turn-1',
              type: 'subagent',
              agentThreadId: 'thread-1',
              agentType: 'Explorer',
              description: 'Inspect the runtime event flow',
              status: 'done',
              createdAt: 1770000000000,
              children: [
                {
                  id: 'child-text-1',
                  subtaskId: 'turn-1',
                  parentToolUseId: 'subagent-thread-1',
                  type: 'text',
                  content: 'Tracing child message deltas',
                  status: 'done',
                  createdAt: 1770000000100,
                },
              ],
            },
          ],
        },
      ],
    })

    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
    expect(screen.getByTestId('environment-subagents-section')).toHaveTextContent('1 已完成')
    expect(screen.getByTestId('open-subagents-panel-button')).toHaveAccessibleName(
      '打开子代理（1）'
    )

    await userEvent.click(screen.getByTestId('open-subagents-panel-button'))

    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()
    expect(screen.getByTestId('subagent-overview-panel')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-subagents-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await userEvent.click(screen.getByTestId('subagent-overview-item'))

    await waitFor(() => {
      expect(screen.getByTestId('subagent-conversation-panel')).toHaveTextContent(
        'Loaded from the persisted child thread'
      )
    })
    expect(loadRuntimeTranscriptForPane).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'runtime-subagent-panel',
        threadId: 'thread-1',
      }),
      { includeFullContent: true, threadOnly: true }
    )
    expect(screen.getByTestId('right-workspace-panel')).toContainElement(
      screen.getByTestId('subagent-conversation-panel')
    )
    expect(screen.getByTestId('right-workspace-subagents-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('right-workspace-panel-shell')).toHaveAttribute(
      'aria-hidden',
      'false'
    )

    await userEvent.click(screen.getByTestId('subagent-conversation-back'))

    expect(screen.queryByTestId('subagent-conversation-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('subagent-overview-panel')).toBeInTheDocument()
    expect(screen.getByTestId('subagent-overview-item')).toHaveTextContent(
      'Inspect the runtime event flow'
    )
    expect(screen.getByTestId('right-workspace-subagents-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await userEvent.click(screen.getByTestId('right-workspace-new-tab-button'))
    await userEvent.click(
      within(screen.getByTestId('right-workspace-new-tab-menu')).getByTestId(
        'right-workspace-review-option'
      )
    )
    expect(await screen.findByTestId('file-changes-review-panel')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-review-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await userEvent.click(screen.getByTestId('right-workspace-subagents-tab'))
    expect(screen.getByTestId('subagent-overview-panel')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('right-workspace-subagents-tab-close-button'))

    await waitFor(() => {
      expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
    })
    expect(screen.getByTestId('environment-subagents-section')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-review-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('right-workspace-panel-shell')).toHaveAttribute(
      'aria-hidden',
      'false'
    )
  })

  test.each(['launcher', 'chat'])(
    'keeps a pending MCP confirmation visible above the expanded %s panel',
    async panel => {
      renderWorkspacePanelLayout({
        mainWidth: 1000,
        messages: [
          {
            id: 'assistant-publish-confirmation',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-10-22T00:00:00.000Z',
            blocks: [
              {
                id: 'publish-confirmation',
                type: 'tool',
                toolName: 'request_user_input',
                status: 'pending',
                renderPayload: {
                  kind: 'request_user_input',
                  requestId: 0,
                  interactionScope: 'publish-turn',
                  interactionKind: 'mcp_form',
                  interactionStatus: 'pending',
                  itemId: 'mcp_server_elicitation',
                  questions: [
                    {
                      id: 'decision',
                      question: '请确认是否正式发布当前编辑结果',
                      options: [{ label: '确认发布' }, { label: '暂不发布' }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      })

      await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
      if (panel === 'chat') {
        await userEvent.click(screen.getByTestId('right-workspace-chat-option'))
      }
      await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-expanded-button'))

      expect(screen.getAllByTestId('request-user-input-card')).toHaveLength(1)
      expect(screen.getByTestId('request-user-input-card')).toBeVisible()
      expect(screen.getByTestId('desktop-floating-composer-layer')).toHaveClass('z-critical')
      expect(screen.queryAllByTestId('project-chat-composer')).toHaveLength(
        panel === 'chat' ? 1 : 0
      )

      await userEvent.click(screen.getByTestId('request-user-input-option-decision-0'))

      const response = {
        requestId: 0,
        interactionScope: 'publish-turn',
        itemId: 'mcp_server_elicitation',
        answers: { decision: { answers: ['确认发布'] } },
      }
      expect(baseProps.onRequestUserInputSubmit).toHaveBeenCalledWith(response, {
        requestUserInputResponses: [response],
        appendUserMessage: false,
        forceDefaultCollaborationMode: false,
      })
    }
  )

  test.each(['timeout'])(
    'restores the composer after MCP expiry on %s without a runtime settlement event',
    async trigger => {
      vi.useFakeTimers()
      const deadline = Date.now() + 1_000
      const view = renderWorkspacePanelLayout({
        messages: [
          {
            id: 'assistant-expiring-confirmation',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-10-22T00:00:00.000Z',
            blocks: [
              {
                id: 'expiring-confirmation',
                type: 'tool',
                toolName: 'request_user_input',
                status: 'pending',
                renderPayload: {
                  kind: 'request_user_input',
                  requestId: 0,
                  interactionScope: 'expiring-turn',
                  interactionKind: 'mcp_form',
                  interactionStatus: 'pending',
                  expiresAtUnixMs: deadline,
                  questions: [
                    { id: 'decision', question: '确认发布？', options: [{ label: '确认' }] },
                  ],
                },
              },
            ],
          },
        ],
      })
      try {
        expect(screen.getByTestId('request-user-input-card')).toBeVisible()
        expect(screen.queryByTestId('project-chat-composer')).not.toBeInTheDocument()

        await act(async () => {
          if (trigger === 'focus') {
            vi.setSystemTime(deadline)
            fireEvent.focus(window)
          } else {
            await vi.advanceTimersByTimeAsync(1_000)
          }
        })

        expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
        expect(screen.getByTestId('project-chat-composer')).toBeVisible()
        expect(baseProps.onRequestUserInputSubmit).not.toHaveBeenCalled()
        const session = paneSessionMockRef.current as {
          ignoreRequestUserInput: ReturnType<typeof vi.fn>
        }
        expect(session.ignoreRequestUserInput).not.toHaveBeenCalled()
        expect(screen.getByTestId('request-user-input-expired')).toHaveTextContent('请求已超时')
      } finally {
        view.unmount()
        vi.useRealTimers()
      }
    }
  )

  test('opens the browser from the right workspace launcher row', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))

    const browserTab = screen.getByTestId('right-workspace-browser-tab-1')
    expect(browserTab).toHaveAttribute('role', 'tab')
    expect(browserTab).toHaveAttribute('aria-selected', 'true')
    expect(browserTab).toHaveTextContent(/^新选项卡$/)
    expect(browserTab.querySelector('svg, img')).toBeTruthy()
    expect(screen.getByTestId('workspace-browser-panel')).toHaveClass('bg-background')
    expect(screen.getByTestId('workspace-browser-url-input')).toBeInTheDocument()

    await userEvent.type(screen.getByTestId('workspace-browser-url-input'), 'example.com{Enter}')

    expect(browserTab).toHaveTextContent(/^example.com$/)
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'http://example.com/'
    )
    expect(screen.getByTestId('workspace-browser-frame')).toHaveClass('bg-background')
  })

  test('preserves the browser tab after closing and reopening the right workspace area', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))
    await userEvent.type(screen.getByTestId('workspace-browser-url-input'), 'example.com{Enter}')

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    const rightPanelShell = screen.getByTestId('right-workspace-panel-shell')
    expect(rightPanelShell).toHaveAttribute('aria-hidden', 'true')
    expect(rightPanelShell).toHaveStyle({ width: '0px' })
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-browser-panel')).toHaveClass('hidden')
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('http://example.com/')
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'http://example.com/'
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(rightPanelShell).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByTestId('right-workspace-browser-tab-1')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('workspace-browser-panel')).not.toHaveClass('hidden')
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('http://example.com/')
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'http://example.com/'
    )
  })

  test('does not close an ordinary browser when its workbench surface is disposed', async () => {
    runtimeMocks.electron = true
    const { unmount } = renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))
    expect(screen.getByTestId('right-workspace-browser-tab-1')).toBeInTheDocument()
    embeddedBrowserMocks.closeEmbeddedBrowser.mockClear()

    unmount()

    expect(embeddedBrowserMocks.closeEmbeddedBrowser).not.toHaveBeenCalled()
  })

  test('right workspace panel opens the file tab from the launcher', async () => {
    renderWorkspacePanelLayout()

    fireEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-option')).toHaveClass(
      'h-11',
      'rounded-xl',
      'font-light'
    )
    expect(screen.getByTestId('right-workspace-file-option')).toHaveTextContent('⌥⌘F')
    fireEvent.click(screen.getByTestId('right-workspace-file-option'))

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
      'opacity-100',
      'md:opacity-0',
      '[@media(pointer:coarse)]:opacity-100',
      'group-hover/tab:opacity-100',
      'focus-within:opacity-100'
    )
    expect(closeButton).toHaveClass(
      'h-11',
      'w-11',
      'md:h-6',
      'md:w-6',
      'rounded-full',
      'hover:bg-text-primary/70',
      'hover:text-background'
    )
    expect(closeButton).not.toHaveClass('ml-auto')
    expect(closeButton).not.toHaveClass('border', 'bg-muted')
    expect(screen.getByTestId('right-workspace-new-tab-button')).toBeInTheDocument()
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
  })

  test('keeps the active right workspace panel when the blank composer creates its first task', async () => {
    const tabs = [{ id: 'test:inspector', title: 'DSH Inspector', order: 5 }]
    const entries = tabs.map(tab => ({ ...tab, label: tab.title }))
    window.__WEWORK_DSH_UI__ = {
      getEntries: slot => (slot === 'wework.workspace.sidebar.tab' ? entries : []),
      subscribe: () => () => undefined,
      attach: (_slot, _id, container, props) => {
        const panel = document.createElement('section')
        panel.dataset.testid = 'dsh-inspector-panel'
        panel.dataset.visible = String(props.visible)
        container.append(panel)
        return {
          update(nextProps) {
            panel.dataset.visible = String(nextProps.visible)
          },
          dispose() {
            panel.remove()
          },
        }
      },
    }

    try {
      const { propsForTask, taskA } = createLocalRuntimeTaskPanelFixture()
      const taskProps = propsForTask(taskA)
      const onSend = vi.fn(
        async (
          _value?: string,
          options?: {
            onRuntimeTaskCreated?: (address: RuntimeTaskAddress) => void
          }
        ) => {
          options?.onRuntimeTaskCreated?.(taskA)
          return true
        }
      )
      const blankProps = {
        ...taskProps,
        onSend,
        state: {
          ...taskProps.state,
          currentRuntimeTask: null,
          input: 'Start plugin work',
        },
      }
      const { rerender } = render(<DesktopWorkbenchLayout {...blankProps} />)

      await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
      await userEvent.click(screen.getByTestId('right-workspace-extension-option-test:inspector'))
      expect(screen.getByTestId('dsh-inspector-panel')).toHaveAttribute('data-visible', 'true')

      await userEvent.click(screen.getByTestId('send-message-button'))
      expect(onSend).toHaveBeenCalledOnce()
      rerender(<DesktopWorkbenchLayout {...taskProps} />)

      expect(screen.getByTestId('right-workspace-panel-shell')).toHaveAttribute(
        'aria-hidden',
        'false'
      )
      expect(screen.getByTestId('right-workspace-extension-tab-test%3Ainspector')).toHaveAttribute(
        'aria-selected',
        'true'
      )
      expect(screen.getByTestId('dsh-inspector-panel')).toHaveAttribute('data-visible', 'true')
    } finally {
      delete window.__WEWORK_DSH_UI__
    }
  })

  test('right workspace launcher keyboard shortcut opens the file tab', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('chat-message-input'), {
      key: 'f',
      metaKey: true,
      altKey: true,
    })

    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
  })

  test.each(['success', 'failure'])(
    'panel shortcut preserves file edits through save %s',
    async outcome => {
      const user = userEvent.setup()
      const original = {
        path: '/workspace/project/notes.txt',
        name: 'notes.txt',
        content: 'hello',
        editable: true,
        revision: 'revision-old',
        truncated: false,
        size: 5,
      }
      const saved = { ...original, content: 'hello world', revision: 'revision-new', size: 11 }
      const pendingSave = createDeferred<typeof saved>()
      const writeWorkspaceTextFile = vi
        .fn()
        .mockReturnValueOnce(pendingSave.promise)
        .mockResolvedValue(saved)
      renderWorkspacePanelLayout({
        workspaceFileApi: {
          listWorkspaceEntries: vi.fn().mockResolvedValue({
            path: '/workspace/project',
            entries: [{ ...original, isDirectory: false, modifiedAt: null }],
          }),
          readWorkspaceTextFile: vi.fn().mockResolvedValue(original),
          writeWorkspaceTextFile,
        },
      })
      fireEvent.keyDown(screen.getByTestId('chat-message-input'), {
        key: 'ƒ',
        code: 'KeyF',
        metaKey: true,
        altKey: true,
      })
      await user.click(await screen.findByText('notes.txt'))
      const editor = await screen.findByTestId('workspace-file-editor')
      const content = await replaceWorkspaceEditorText(editor, 'hello world')

      fireEvent.keyDown(content, { key: 'ß', code: 'KeyS', metaKey: true, altKey: true })

      await waitFor(() =>
        expect(writeWorkspaceTextFile).toHaveBeenCalledWith(
          'workspace-cloud-device',
          original.path,
          saved.content,
          original.revision
        )
      )
      expect(getWorkspaceCodeText()).toContain(saved.content)
      expect(screen.queryByTestId('right-workspace-chat-panel')).not.toBeInTheDocument()
      fireEvent.keyDown(content, { key: 'ß', code: 'KeyS', metaKey: true, altKey: true })
      expect(writeWorkspaceTextFile).toHaveBeenCalledOnce()
      if (outcome === 'failure') {
        await act(async () => pendingSave.reject(new Error('Write failed')))
        expect(await screen.findByTestId('workspace-file-save-error')).toHaveTextContent(
          'Write failed'
        )
        expect(getWorkspaceCodeText()).toContain(saved.content)
        expect(screen.queryByTestId('right-workspace-chat-panel')).not.toBeInTheDocument()
        await user.click(screen.getByTestId('workspace-file-save-retry-button'))
      } else {
        await act(async () => pendingSave.resolve(saved))
      }
      expect(await screen.findByTestId('right-workspace-chat-panel')).toBeInTheDocument()
      expect(writeWorkspaceTextFile).toHaveBeenCalledTimes(outcome === 'failure' ? 2 : 1)
    }
  )

  test.each([
    { key: '®', code: 'KeyR', panel: 'file-changes-review-panel' },
    { key: 'ß', code: 'KeyS', panel: 'right-workspace-chat-panel' },
    { key: 'ƒ', code: 'KeyF', panel: 'workspace-file-tree' },
  ])(
    'conversation shortcut $code opens and reopens a closed right panel',
    async ({ key, code, panel }) => {
      renderWorkspacePanelLayout()
      await waitFor(() =>
        expect(baseProps.onLoadEnvironmentInfo).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ path: '/workspace/project' }),
          expect.anything()
        )
      )
      expect(screen.queryByTestId('right-workspace-panel')).not.toBeInTheDocument()
      const shortcut = { key, code, metaKey: true, altKey: true }
      const composer = screen.getByTestId('chat-message-input')

      fireEvent.keyDown(composer, shortcut)

      expect(await screen.findByTestId(panel)).toBeInTheDocument()
      expect(screen.getByTestId('right-workspace-panel-shell')).toHaveAttribute(
        'aria-hidden',
        'false'
      )
      await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
      expect(screen.getByTestId('right-workspace-panel-shell')).toHaveAttribute(
        'aria-hidden',
        'true'
      )

      fireEvent.keyDown(composer, shortcut)

      expect(await screen.findByTestId(panel)).toBeInTheDocument()
      expect(screen.getByTestId('right-workspace-panel-shell')).toHaveAttribute(
        'aria-hidden',
        'false'
      )
    }
  )

  test('temporary chat uses the refreshed source thread when the route address is stale', async () => {
    const { propsForTask, runtimeWork, taskA } = createLocalRuntimeTaskPanelFixture()
    const props = propsForTask(taskA, { runtimeWork })
    createTemporaryRuntimeTaskMock.mockResolvedValue(false)
    const view = render(<DesktopWorkbenchLayout {...props} />)

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(await screen.findByTestId('right-workspace-chat-option'))

    const sourceTask = runtimeWork.projects[0]?.deviceWorkspaces[0]?.tasks.find(
      task => task.taskId === taskA.taskId
    )
    if (!sourceTask) throw new Error('Source task fixture was not found')
    sourceTask.runtimeHandle = { threadId: 'thread-a' }
    view.rerender(<DesktopWorkbenchLayout {...props} messages={[]} />)

    const sideChat = await screen.findByTestId('right-workspace-chat-panel')
    await userEvent.type(within(sideChat).getByTestId('chat-message-input'), 'side chat')
    await userEvent.click(within(sideChat).getByTestId('send-message-button'))

    await waitFor(() =>
      expect(createTemporaryRuntimeTaskMock).toHaveBeenCalledWith(
        'side chat',
        expect.objectContaining({
          source: expect.objectContaining({
            deviceId: taskA.deviceId,
            taskId: taskA.taskId,
            workspacePath: taskA.workspacePath,
            runtimeHandle: { threadId: 'thread-a' },
          }),
        })
      )
    )
  }, 30_000)

  test('temporary chat queues a follow-up while its current response is running', async () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'workspace-cloud-device',
      taskId: 'runtime-side-chat-queue',
      workspacePath: '/workspace/project',
    }
    createTemporaryRuntimeTaskMock.mockImplementation(async (_input, options) => {
      sideChatLifecycleStore.sendRequested(address)
      await openOptimisticTemporaryRuntimeTask(address, options)
      return address
    })
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(await screen.findByTestId('right-workspace-chat-option'))

    const sideChat = await screen.findByTestId('right-workspace-chat-panel')
    setComposerValue(sideChat, 'first message')
    await userEvent.click(within(sideChat).getByTestId('send-message-button'))
    await waitFor(() => expect(createTemporaryRuntimeTaskMock).toHaveBeenCalledTimes(1))

    setComposerValue(sideChat, 'queued follow-up')
    await userEvent.click(within(sideChat).getByTestId('send-message-button'))

    expect(sendRuntimePaneMessageMock).not.toHaveBeenCalled()
    expect(within(sideChat).getByTestId('conversation-queue-panel')).toHaveTextContent(
      'queued follow-up'
    )
    expect(within(sideChat).queryByTestId('chat-input-error')).not.toBeInTheDocument()

    act(() => {
      sideChatLifecycleStore.syncTranscript(address, {
        running: false,
        turns: [],
      } as RuntimePaneTranscript)
    })

    await waitFor(() => expect(sendRuntimePaneMessageMock).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(within(sideChat).queryByTestId('conversation-queue-panel')).not.toBeInTheDocument()
    )
    expect(within(sideChat).getAllByTestId('user-message-content').at(-1)).toHaveTextContent(
      'queued follow-up'
    )
  }, 30_000)

  test('temporary chat sends a busy follow-up as guidance when selected', async () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'workspace-cloud-device',
      taskId: 'runtime-side-chat-guidance',
      workspacePath: '/workspace/project',
    }
    createTemporaryRuntimeTaskMock.mockImplementation(async (_input, options) => {
      sideChatLifecycleStore.sendRequested(address)
      await openOptimisticTemporaryRuntimeTask(address, options)
      return address
    })
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(await screen.findByTestId('right-workspace-chat-option'))

    const sideChat = await screen.findByTestId('right-workspace-chat-panel')
    setComposerValue(sideChat, 'first message')
    await userEvent.click(within(sideChat).getByTestId('send-message-button'))
    await waitFor(() => expect(createTemporaryRuntimeTaskMock).toHaveBeenCalledTimes(1))

    setComposerValue(sideChat, 'guide the current response')
    await userEvent.click(within(sideChat).getByTestId('send-mode-menu-button'))
    await userEvent.click(await screen.findByTestId('guide-current-turn-option'))

    await waitFor(() => expect(sendRuntimePaneGuidanceMock).toHaveBeenCalledTimes(1))
    expect(sendRuntimePaneMessageMock).not.toHaveBeenCalled()
    const guidanceRequest = sendRuntimePaneGuidanceMock.mock.calls[0]?.[0]
    expect(guidanceRequest).toMatchObject({
      address,
      message: 'guide the current response',
    })
    expect(guidanceRequest.clientGuidanceId).toEqual(expect.any(String))
    expect(within(sideChat).getByTestId('conversation-queue-panel')).toHaveTextContent(
      'guide the current response'
    )
    expect(within(sideChat).getByTestId('conversation-queue-panel')).toHaveTextContent('引导中')

    const streamHandlers = subscribeRuntimeTaskStreamMock.mock.calls.at(-1)?.[1] as
      | {
          onGuidanceApplied?: (payload: {
            taskId: string
            subtaskId: string
            deviceId: string
            guidanceId: string
            clientGuidanceId: string
            message: string
            appliedAtMs: number
          }) => void
        }
      | undefined
    act(() =>
      streamHandlers?.onGuidanceApplied?.({
        taskId: address.taskId,
        subtaskId: 'runtime-side-chat-turn',
        deviceId: address.deviceId,
        guidanceId: 'runtime-guidance',
        clientGuidanceId: guidanceRequest.clientGuidanceId,
        message: 'guide the current response',
        appliedAtMs: Date.now(),
      })
    )

    await waitFor(() =>
      expect(within(sideChat).queryByTestId('conversation-queue-panel')).not.toBeInTheDocument()
    )
    expect(within(sideChat).getAllByTestId('user-message-content').at(-1)).toHaveTextContent(
      'guide the current response'
    )
  }, 30_000)

  test('editing a temporary chat queued message replaces draft attachments', async () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'workspace-cloud-device',
      taskId: 'runtime-side-chat-queued-attachments',
      workspacePath: '/workspace/project',
    }
    createTemporaryRuntimeTaskMock.mockImplementation(async (_input, options) => {
      sideChatLifecycleStore.sendRequested(address)
      await openOptimisticTemporaryRuntimeTask(address, options)
      return address
    })
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(await screen.findByTestId('right-workspace-chat-option'))

    const sideChat = await screen.findByTestId('right-workspace-chat-panel')
    const sideChatInput = within(sideChat).getByTestId('chat-message-input')
    await userEvent.type(sideChatInput, 'first message')
    await userEvent.click(within(sideChat).getByTestId('send-message-button'))
    await waitFor(() => expect(createTemporaryRuntimeTaskMock).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(within(sideChat).getByTestId('user-message-content')).toHaveTextContent(
        'first message'
      )
    )

    await userEvent.upload(
      within(sideChat).getByTestId('attachment-file-input'),
      new File(['queued attachment'], 'queued-attachment.txt', { type: 'text/plain' })
    )
    expect(
      await within(sideChat).findByTestId('attachment-document-preview-button')
    ).toHaveAccessibleName('queued-attachment.txt')
    await userEvent.type(sideChatInput, 'queued follow-up')
    await userEvent.click(within(sideChat).getByTestId('send-message-button'))
    expect(within(sideChat).getByTestId('conversation-queue-panel')).toBeInTheDocument()

    await userEvent.upload(
      within(sideChat).getByTestId('attachment-file-input'),
      new File(['draft attachment'], 'draft-attachment.txt', { type: 'text/plain' })
    )
    expect(
      await within(sideChat).findByTestId('attachment-document-preview-button')
    ).toHaveAccessibleName('draft-attachment.txt')

    await userEvent.click(within(sideChat).getByTestId(/queue-more-button-/))
    await userEvent.click(await screen.findByTestId(/queue-edit-button-/))

    await waitFor(() =>
      expect(within(sideChat).getByTestId('chat-message-input')).toHaveValue('queued follow-up')
    )
    expect(within(sideChat).getAllByTestId('attachment-badge')).toHaveLength(1)
    expect(within(sideChat).getByTitle('queued-attachment.txt')).toBeInTheDocument()
    expect(within(sideChat).queryByTitle('draft-attachment.txt')).not.toBeInTheDocument()
  }, 30_000)

  test('temporary chat keeps a stale busy rejection queued without blind retries', async () => {
    // Queue semantics do not require timer-paced typing, which can outlive a timed-out test.
    const user = userEvent.setup({ delay: null })
    const address: RuntimeTaskAddress = {
      deviceId: 'workspace-cloud-device',
      taskId: 'runtime-side-chat-stale-busy',
      workspacePath: '/workspace/project',
    }
    createTemporaryRuntimeTaskMock.mockImplementation(async (_input, options) => {
      await openOptimisticTemporaryRuntimeTask(address, options)
      return address
    })
    sendRuntimePaneMessageMock.mockImplementation(async (_request, options) => {
      options?.onError?.('runtime task is already running')
      return false
    })
    renderWorkspacePanelLayout()

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(await screen.findByTestId('right-workspace-chat-option'))

    const sideChat = await screen.findByTestId('right-workspace-chat-panel')
    const sideChatInput = within(sideChat).getByTestId('chat-message-input')
    await user.type(sideChatInput, 'first message')
    await user.click(within(sideChat).getByTestId('send-message-button'))
    await waitFor(() => expect(subscribeRuntimeTaskStreamMock).toHaveBeenCalled())

    const streamHandlers = subscribeRuntimeTaskStreamMock.mock.calls.at(-1)?.[1] as
      | { onAssistantStart?: () => void }
      | undefined
    act(() => streamHandlers?.onAssistantStart?.())

    await user.type(sideChatInput, 'follow-up during stale state')
    await user.click(within(sideChat).getByTestId('send-message-button'))

    await waitFor(() => expect(sendRuntimePaneMessageMock).toHaveBeenCalledTimes(1))
    expect(within(sideChat).getByTestId('conversation-queue-panel')).toHaveTextContent(
      'follow-up during stale state'
    )
    expect(within(sideChat).queryByTestId('chat-input-error')).not.toBeInTheDocument()

    expect(sendRuntimePaneMessageMock).toHaveBeenCalledTimes(1)
  }, 30_000)

  test('temporary chat marks a rejected queued send as failed', async () => {
    // Queue semantics do not require timer-paced typing, which can outlive a timed-out test.
    const user = userEvent.setup({ delay: null })
    const address: RuntimeTaskAddress = {
      deviceId: 'workspace-cloud-device',
      taskId: 'runtime-side-chat-rejected-queue',
      workspacePath: '/workspace/project',
    }
    createTemporaryRuntimeTaskMock.mockImplementation(async (_input, options) => {
      sideChatLifecycleStore.sendRequested(address)
      await openOptimisticTemporaryRuntimeTask(address, options)
      return address
    })
    sendRuntimePaneMessageMock.mockRejectedValueOnce(new Error('network unavailable'))
    renderWorkspacePanelLayout()

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(await screen.findByTestId('right-workspace-chat-option'))

    const sideChat = await screen.findByTestId('right-workspace-chat-panel')
    const sideChatInput = within(sideChat).getByTestId('chat-message-input')
    await user.type(sideChatInput, 'first message')
    await user.click(within(sideChat).getByTestId('send-message-button'))
    await waitFor(() => expect(subscribeRuntimeTaskStreamMock).toHaveBeenCalled())

    await user.type(sideChatInput, 'queued follow-up')
    await user.click(within(sideChat).getByTestId('send-message-button'))
    expect(within(sideChat).getByTestId('conversation-queue-panel')).toHaveTextContent(
      'queued follow-up'
    )

    act(() => {
      sideChatLifecycleStore.syncTranscript(address, {
        running: false,
        turns: [],
      } as RuntimePaneTranscript)
    })

    await waitFor(() =>
      expect(within(sideChat).getByTestId('conversation-queue-panel')).toHaveTextContent(
        'network unavailable'
      )
    )
    expect(sendRuntimePaneMessageMock).toHaveBeenCalledTimes(1)
  }, 30_000)

  test('temporary chat rolls back its optimistic address when runtime creation fails', async () => {
    const createResult = createDeferred<RuntimeTaskAddress | false>()
    const optimisticAddress: RuntimeTaskAddress = {
      deviceId: 'workspace-cloud-device',
      taskId: 'runtime-side-chat-failed',
      workspacePath: '/workspace/project',
    }
    const unsubscribe = vi.fn()
    subscribeRuntimeTaskStreamMock.mockReturnValue(unsubscribe)
    createTemporaryRuntimeTaskMock.mockImplementation(async (_input, options) => {
      await openOptimisticTemporaryRuntimeTask(optimisticAddress, options)
      return createResult.promise
    })
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(await screen.findByTestId('right-workspace-chat-option'))

    const sideChat = await screen.findByTestId('right-workspace-chat-panel')
    const sideChatInput = within(sideChat).getByTestId('chat-message-input')
    await userEvent.type(sideChatInput, 'side chat')
    await userEvent.click(within(sideChat).getByTestId('send-message-button'))
    expect(sideChatInput).toHaveValue('')

    await waitFor(() =>
      expect(subscribeRuntimeTaskStreamMock).toHaveBeenCalledWith(
        optimisticAddress,
        expect.any(Object)
      )
    )

    await act(async () => {
      createResult.resolve(false)
      await createResult.promise
    })

    await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1))
    expect(sideChatInput).toHaveValue('side chat')
    expect(within(sideChat).getByTestId('send-message-button')).toBeEnabled()
  }, 30_000)

  test('does not show inactive runtime task right workspace tabs in the Electron titlebar', async () => {
    runtimeMocks.electron = true
    const { propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()

    mockDesktopWorkbenchMainWidth(1000)
    const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))

    const titlebarRightPanel = screen.getByTestId('titlebar-right-panel')
    const sharedMainHeader = screen.getByTestId('workbench-main-header')
    expect(within(titlebarRightPanel).getByTestId('right-workspace-file-tab')).toBeInTheDocument()

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)

    expect(screen.getAllByTestId('workbench-main-header')).toHaveLength(1)
    expect(screen.getByTestId('workbench-main-header')).toBe(sharedMainHeader)
    expect(sharedMainHeader).toHaveClass('h-[38px]', 'shrink-0')
    expect(screen.getAllByTestId('workbench-pane-task-title')).toHaveLength(1)
    expect(screen.getByTestId('workbench-pane-task-title')).toHaveTextContent('Task B')
    expect(screen.getByTestId('workbench-pane-task-title')).not.toHaveTextContent('Task A')
    expect(within(titlebarRightPanel).queryByTestId('right-workspace-file-tab')).toBeNull()
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
      'opacity-100',
      'md:opacity-0',
      '[@media(pointer:coarse)]:opacity-100',
      'group-hover/tab:opacity-100',
      'focus-within:opacity-100'
    )
    expect(closeButton).toHaveClass(
      'h-11',
      'w-11',
      'md:h-6',
      'md:w-6',
      'rounded-full',
      'hover:bg-text-primary/70',
      'hover:text-background'
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

  test.each(['workspace', 'worktree'])(
    'preserves the owner boundary for a queued unlisted %s subdirectory deliverable',
    async workspaceKind => {
      const { queueWorkbenchWorkspaceLaunch } =
        await import('@/features/workbench/workspaceLaunchRequest')
      const workspace = createCloudWorkspacePanelState()
      const task = {
        deviceId: workspace.devices[0].device_id,
        taskId: 'stand-in-chat-7-primary',
        workspacePath: '/workspace/project/fixtures',
        workspaceKind,
        ...(workspaceKind === 'worktree' ? { worktreeId: 'ancestor-worktree' } : {}),
      }
      const readWorkspaceTextFile = vi.fn().mockResolvedValue({
        path: '/workspace/project/fixtures/cart-fixture/cart-review.md',
        name: 'cart-review.md',
        content: 'Persisted zero quantity regression passes.',
        truncated: false,
        size: 42,
        modifiedAt: null,
      })
      queueWorkbenchWorkspaceLaunch(task.deviceId, task.workspacePath, {
        taskId: task.taskId,
        openFile: { path: 'cart-fixture/cart-review.md', options: { lineStart: 2, lineEnd: 4 } },
      })
      render(
        <DesktopWorkbenchLayout
          {...baseProps}
          state={{ ...baseProps.state, ...workspace, currentRuntimeTask: task }}
          workspaceFileApi={{
            listWorkspaceEntries: vi
              .fn()
              .mockResolvedValue({ path: task.workspacePath, entries: [] }),
            readWorkspaceTextFile,
          }}
          projectWork={{
            ...baseProps.projectWork,
            projects: workspace.projects,
            devices: workspace.devices,
            currentProjectId: workspace.currentProject.id,
          }}
        />
      )
      if (workspaceKind === 'worktree') {
        await act(async () => {})
        const { getWorkbenchWorkspaceLaunch, clearWorkbenchWorkspaceLaunch } =
          await import('@/features/workbench/workspaceLaunchRequest')
        expect(getWorkbenchWorkspaceLaunch()?.options.taskId).toBe(task.taskId)
        expect(readWorkspaceTextFile).not.toHaveBeenCalled()
        expect(screen.queryByTestId('workspace-file-path')).not.toBeInTheDocument()
        act(() => clearWorkbenchWorkspaceLaunch())
        return
      }
      await waitFor(() =>
        expect(readWorkspaceTextFile).toHaveBeenCalledWith(
          task.deviceId,
          '/workspace/project/fixtures/cart-fixture/cart-review.md',
          task.workspacePath
        )
      )
      expect(await screen.findByTestId('workspace-markdown-preview')).toHaveTextContent(
        'Persisted zero quantity regression passes.'
      )
      const followupFile = {
        path: '/workspace/project/fixtures/cart-fixture/followup.md',
        name: 'followup.md',
        content: 'A second click on the same open task.',
        truncated: false,
        size: 36,
        modifiedAt: null,
      }
      const followupRead = createDeferred<typeof followupFile>()
      readWorkspaceTextFile.mockReturnValueOnce(followupRead.promise)
      act(() => {
        queueWorkbenchWorkspaceLaunch(task.deviceId, task.workspacePath, {
          taskId: task.taskId,
          openFile: { path: 'cart-fixture/followup.md' },
        })
      })
      await waitFor(() =>
        expect(readWorkspaceTextFile).toHaveBeenCalledWith(
          task.deviceId,
          '/workspace/project/fixtures/cart-fixture/followup.md',
          task.workspacePath
        )
      )
      expect(screen.getByTestId('workspace-markdown-preview')).toHaveTextContent(
        'Persisted zero quantity regression passes.'
      )
      expect(screen.getByTestId('workspace-markdown-preview')).not.toHaveTextContent(
        followupFile.content
      )
      await act(async () => followupRead.resolve(followupFile))
      await waitFor(() =>
        expect(screen.getByTestId('workspace-markdown-preview')).toHaveTextContent(
          'A second click on the same open task.'
        )
      )
    }
  )

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

    expect(await screen.findByTestId('workspace-markdown-preview')).toHaveTextContent('hello world')
    expect(screen.getByTestId('workspace-file-path')).toHaveTextContent(
      '/workspace/project/README.md'
    )
    expect(screen.getByTestId('workspace-file-markdown-mode-button')).toHaveClass(
      'h-11',
      'min-w-11',
      'md:h-8',
      'md:min-w-0'
    )
  })

  test('keeps project-root breadcrumbs and opens dropdown files in distinct reusable tabs', async () => {
    const user = userEvent.setup()
    const localDevice = createLocalSkillDevice()
    const project = {
      ...createCloudWorkspacePanelState().currentProject,
      config: {
        mode: 'workspace' as const,
        execution: { targetType: 'local' as const, deviceId: localDevice.device_id },
        workspace: { source: 'git' as const, checkoutPath: '/fixture/repo' },
      },
    }
    const path = '/fixture/repo/backend/app/schemas/quick_launch.py'
    const siblingPath = '/fixture/repo/backend/app/schemas/admin.py'
    const contents = new Map([
      [path, 'fixture = True'],
      [siblingPath, 'admin = True'],
    ])
    getLocalPathKindMock.mockResolvedValue('file')
    const fileResponse = (filePath: string) => ({
      path: filePath,
      name: filePath.split('/').at(-1),
      content: contents.get(filePath),
      editable: true,
      revision: 'fixture-revision',
      truncated: false,
      size: 14,
      modifiedAt: null,
    })
    const readWorkspaceTextFile = vi
      .fn()
      .mockImplementation((_device, path) => Promise.resolve(fileResponse(path)))
    const writeWorkspaceTextFile = vi.fn().mockImplementation((_device, path, content) => {
      contents.set(path, content)
      return Promise.resolve(fileResponse(path))
    })
    const listWorkspaceEntries = vi.fn().mockImplementation((_device, directory) =>
      Promise.resolve({
        path: directory,
        entries: directory.endsWith('/schemas')
          ? [path, siblingPath].map(filePath => ({
              path: filePath,
              name: filePath.split('/').at(-1),
              isDirectory: false,
              size: 14,
            }))
          : [],
      })
    )
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{ listWorkspaceEntries, readWorkspaceTextFile, writeWorkspaceTextFile }}
        state={{
          ...baseProps.state,
          currentProject: project,
          projects: [project],
          devices: [localDevice],
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: [project],
          devices: [localDevice],
          currentProjectId: project.id,
        }}
        messages={[
          {
            id: 'nested-file-link',
            role: 'assistant',
            content: `[quick_launch.py](${path})`,
            status: 'done',
            createdAt: '2026-09-22T00:00:00.000Z',
          },
        ]}
      />
    )
    await screen.findByTestId('assistant-markdown-link')
    await waitFor(() =>
      expect(screen.getByTestId('toggle-right-workspace-panel-button')).not.toBeDisabled()
    )
    fireEvent.click(screen.getByTestId('assistant-markdown-link'))
    await waitFor(() =>
      expect(readWorkspaceTextFile).toHaveBeenCalledWith(
        localDevice.device_id,
        path,
        '/fixture/repo'
      )
    )
    expect(await screen.findByTestId('workspace-file-name-button')).toHaveTextContent(
      'quick_launch.py'
    )
    expect(screen.getByTestId('workspace-file-breadcrumb-/fixture/repo')).toHaveTextContent('repo')
    expect(screen.getByTestId('workspace-file-breadcrumb-/fixture/repo/backend')).toHaveTextContent(
      'backend'
    )
    expect(
      screen.getByTestId('workspace-file-breadcrumb-/fixture/repo/backend/app/schemas')
    ).toHaveTextContent('schemas')

    const clickPickerEntry = async (name: string) => {
      const tree = await screen.findByTestId('workspace-file-picker-tree')
      const row = await waitFor(() => {
        const root = tree.shadowRoot ?? tree
        const candidate = Array.from(
          root.querySelectorAll<HTMLElement>('[data-item-path], button')
        ).find(
          item =>
            item.dataset.itemPath === name ||
            item.dataset.itemPath?.endsWith(`/${name}`) ||
            item.textContent === name
        )
        expect(candidate).toBeDefined()
        return candidate!
      })
      fireEvent.click(row)
    }

    await user.click(screen.getByTestId('workspace-file-name-button'))
    await clickPickerEntry('admin.py')
    await waitFor(() =>
      expect(screen.getByTestId('workspace-file-name-button')).toHaveTextContent('admin.py')
    )
    expect(screen.getByRole('tab', { name: /quick_launch.py/ })).toHaveAttribute(
      'aria-selected',
      'false'
    )
    expect(screen.getByRole('tab', { name: /admin.py/ })).toHaveAttribute('aria-selected', 'true')

    await user.click(screen.getByTestId('workspace-file-name-button'))
    await clickPickerEntry('quick_launch.py')
    await waitFor(() =>
      expect(screen.getByTestId('workspace-file-name-button')).toHaveTextContent('quick_launch.py')
    )
    expect(screen.getAllByRole('tab', { name: /quick_launch.py|admin.py/ })).toHaveLength(2)

    await user.click(screen.getByRole('tab', { name: /admin.py/ }))
    await waitFor(() => expect(getWorkspaceCodeText()).toContain('admin = True'))
    await user.click(screen.getByRole('tab', { name: /quick_launch.py/ }))
    await waitFor(() =>
      expect(screen.getByTestId('workspace-file-name-button')).toHaveTextContent('quick_launch.py')
    )
    expect(screen.getByRole('tab', { name: /admin.py/ })).toHaveAttribute('aria-selected', 'false')
    await user.click(
      within(screen.getByRole('tab', { name: /admin.py/ })).getByTestId(/-close-button$/)
    )
    expect(screen.queryByRole('tab', { name: /admin.py/ })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /quick_launch.py/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  }, 15000)

  test.each(['file', 'skill'] as const)(
    'reports home-directory lookup failures when opening a %s reference',
    async kind => {
      const workspacePanelState = createCloudWorkspacePanelState()
      const localDevice = createLocalSkillDevice()
      const devices = [...workspacePanelState.devices, localDevice]
      const getHome = vi.fn().mockRejectedValue(new Error('test home lookup failed'))
      const readWorkspaceTextFile = vi.fn()
      render(
        <DesktopWorkbenchLayout
          {...baseProps}
          onGetDeviceHomeDirectory={getHome}
          projectChat={{
            ...baseProps.projectChat,
            listLocalSkills: async () => [
              {
                name: 'test-skill',
                path: '~/.agents/skills/test/SKILL.md',
                description: '',
                source: 'codex',
              },
            ],
          }}
          workspaceFileApi={{ listWorkspaceEntries: vi.fn(), readWorkspaceTextFile }}
          state={{ ...baseProps.state, ...workspacePanelState, devices }}
          messages={[
            {
              id: 'test-failed-file-reference',
              role: kind === 'file' ? 'assistant' : 'user',
              content:
                kind === 'file'
                  ? '[test-file](~/test.md)'
                  : '[$test-skill](~/.agents/skills/test/SKILL.md)',
              status: 'completed',
              createdAt: '2026-07-11T00:00:00.000Z',
            },
          ]}
          projectWork={{
            ...baseProps.projectWork,
            projects: workspacePanelState.projects,
            devices,
            currentProjectId: workspacePanelState.currentProject.id,
          }}
        />
      )
      fireEvent.click(
        await screen.findByTestId(
          kind === 'file' ? 'assistant-markdown-link' : 'sent-local-skill-token-test-skill'
        )
      )
      expect(await screen.findByTestId('transient-notice')).toHaveTextContent(
        'test home lookup failed'
      )
      expect(readWorkspaceTextFile).not.toHaveBeenCalled()
    }
  )

  test('opens a markdown directory link in the workspace tree without reading it as a file', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    getLocalPathKindMock.mockResolvedValue('directory')
    const listWorkspaceEntries = vi.fn().mockImplementation((_deviceId, path) =>
      Promise.resolve({
        path,
        entries:
          path === '/workspace/project'
            ? [
                {
                  name: 'docs',
                  path: '/workspace/project/docs',
                  isDirectory: true,
                  size: 0,
                  modifiedAt: null,
                },
              ]
            : [],
      })
    )
    const readWorkspaceTextFile = vi.fn()

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
            id: 'assistant-directory-link',
            role: 'assistant',
            content: '[docs](/workspace/project/docs)',
            status: 'done',
            createdAt: '2026-07-25T08:00:00.000Z',
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

    await user.click(screen.getByTestId('assistant-markdown-link'))

    await waitFor(() =>
      expect(listWorkspaceEntries).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project/docs',
        '/workspace/project'
      )
    )
    expect(screen.getByTestId('workspace-file-path')).toHaveTextContent('/workspace/project/docs')
    expect(screen.getByTestId('workspace-file-tree-container')).toHaveClass(
      'w-[240px]',
      'opacity-100'
    )
    expect(readWorkspaceTextFile).not.toHaveBeenCalled()
    expect(screen.queryByText(/无法加载|Failed to load/i)).not.toBeInTheDocument()
  })

  test('opens a local image link on the local device while the project workspace is remote', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const localDevice = createLocalSkillDevice()
    const imagePath = '/Users/me/.wework/workspace/attachments/draft/42/result.png'
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/Users/me/.wework/workspace/attachments/draft/42',
      entries: [],
    })
    const readWorkspaceFileChunk = vi.fn().mockResolvedValue({
      path: imagePath,
      name: 'result.png',
      contentBase64: 'aW1hZ2U=',
      offset: 0,
      size: 5,
      eof: true,
      modifiedAt: null,
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile: vi.fn(),
          readWorkspaceFileChunk,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
          devices: [...workspacePanelState.devices, localDevice],
        }}
        messages={[
          {
            id: 'assistant-local-image-link',
            role: 'assistant',
            content: `[result.png](${imagePath})`,
            status: 'done',
            createdAt: '2026-07-18T00:00:00.000Z',
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: [...workspacePanelState.devices, localDevice],
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    await user.click(await screen.findByTestId('assistant-markdown-link'))

    expect(await screen.findByTestId('workspace-binary-file-preview')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(listWorkspaceEntries).toHaveBeenCalledWith(
      localDevice.device_id,
      '/Users/me/.wework/workspace/attachments/draft/42',
      '/Users/me/.wework/workspace/attachments/draft/42'
    )
    expect(readWorkspaceFileChunk).toHaveBeenCalledWith(
      localDevice.device_id,
      imagePath,
      0,
      '/Users/me/.wework/workspace/attachments/draft/42'
    )
  })

  test.each(
    ['/Users/me/.agents/skills/gmail/SKILL.md', '~/.agents/skills/gmail/SKILL.md'].flatMap(
      referencePath => ['$gmail', 'test-label'].map(label => ({ referencePath, label }))
    )
  )(
    'opens a skill from the empty composer on the real local device: $label ($referencePath)',
    async ({ referencePath, label }) => {
      const user = userEvent.setup()
      const localDevice = createLocalSkillDevice()
      const skillPath = '/Users/me/.agents/skills/gmail/SKILL.md'
      const listWorkspaceEntries = vi.fn().mockResolvedValue({
        path: '/Users/me/.agents/skills/gmail',
        entries: [],
      })
      const readWorkspaceTextFile = vi.fn().mockResolvedValue({
        path: skillPath,
        name: 'SKILL.md',
        content: '# Gmail',
        truncated: false,
        size: 7,
        modifiedAt: null,
      })

      render(
        <DesktopWorkbenchLayout
          {...baseProps}
          workspaceFileApi={{ listWorkspaceEntries, readWorkspaceTextFile }}
          onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/Users/me')}
          state={{
            ...baseProps.state,
            devices: [localDevice],
            input: `[${label}](${referencePath}) `,
          }}
          projectWork={{
            ...baseProps.projectWork,
            devices: [localDevice],
          }}
        />
      )

      await user.click(
        await screen.findByTestId(
          label === '$gmail' ? 'local-skill-chip-gmail' : 'composer-path-chip-test-label'
        )
      )

      expect(await screen.findByTestId('workspace-markdown-preview')).toHaveTextContent('Gmail')
      expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute(
        'aria-selected',
        'true'
      )
      expect(listWorkspaceEntries).toHaveBeenCalledWith(
        localDevice.device_id,
        '/Users/me/.agents/skills/gmail',
        '/Users/me/.agents/skills/gmail'
      )
      expect(readWorkspaceTextFile).toHaveBeenCalledWith(
        localDevice.device_id,
        skillPath,
        '/Users/me/.agents/skills/gmail'
      )
    }
  )

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
    expect(await screen.findByTestId('workspace-markdown-preview')).toHaveTextContent('notes first')

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

    expect(screen.getByTestId('workspace-markdown-preview')).toHaveTextContent('notes first')
    expect(screen.getByTestId('workspace-markdown-preview')).not.toHaveTextContent('readme stale')
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
      '/workspace/project/src',
      '/workspace/project'
    )
  })

  test('workspace file panel previews markdown before editing and autosaves it', async () => {
    const user = userEvent.setup()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'README.md',
          path: '/workspace/project/README.md',
          isDirectory: false,
          size: 5,
          modifiedAt: null,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/README.md',
      name: 'README.md',
      content: 'hello',
      editable: true,
      revision: 'sha256:old',
      truncated: false,
      size: 5,
      modifiedAt: null,
    })
    const writeWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/README.md',
      name: 'README.md',
      content: 'hello world',
      editable: true,
      revision: 'sha256:new',
      truncated: false,
      size: 11,
      modifiedAt: null,
    })

    render(
      <FileWorkspacePanel
        target={{
          deviceId: 'workspace-cloud-device',
          path: '/workspace/project',
          source: 'project',
          workspaceSource: 'remote',
        }}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile,
          writeWorkspaceTextFile,
        }}
        onAddCodeComment={vi.fn()}
      />
    )

    await user.click(await screen.findByText('README.md'))
    expect(await screen.findByTestId('workspace-markdown-preview')).toHaveTextContent('hello')
    expect(screen.queryByTestId('workspace-file-editor')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('workspace-file-markdown-mode-button'))
    const editor = await screen.findByTestId('workspace-file-editor')
    expect(screen.queryByTestId('workspace-file-edit-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-file-save-button')).not.toBeInTheDocument()

    const nativeSetTimeout = window.setTimeout.bind(window)
    let runAutosave: (() => void) | null = null
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation((handler, timeout) => {
      if (timeout === 3_000 && typeof handler === 'function') {
        runAutosave = handler
        return 0
      }
      return nativeSetTimeout(handler, timeout)
    })
    try {
      await replaceWorkspaceEditorText(editor, 'hello world')

      await waitFor(() => expect(runAutosave).not.toBeNull())
      act(() => runAutosave?.())
      await waitFor(() =>
        expect(writeWorkspaceTextFile).toHaveBeenCalledWith(
          'workspace-cloud-device',
          '/workspace/project/README.md',
          'hello world',
          'sha256:old'
        )
      )
      await waitFor(() => {
        expect(screen.getByTestId('workspace-file-editor')).toBeInTheDocument()
        expect(screen.queryByTestId('workspace-file-save-button')).not.toBeInTheDocument()
        expect(screen.queryByTestId('workspace-file-edit-button')).not.toBeInTheDocument()
      })
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  test('workspace file panel saves pending edits before opening another file', async () => {
    const user = userEvent.setup()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'README.md',
          path: '/workspace/project/README.md',
          isDirectory: false,
          size: 5,
          modifiedAt: null,
        },
        {
          name: 'notes.txt',
          path: '/workspace/project/notes.txt',
          isDirectory: false,
          size: 5,
          modifiedAt: null,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn().mockImplementation((_deviceId, path) =>
      Promise.resolve({
        path,
        name: path.endsWith('README.md') ? 'README.md' : 'notes.txt',
        content: path.endsWith('README.md') ? 'hello' : 'notes',
        editable: true,
        revision: path.endsWith('README.md') ? 'sha256:readme' : 'sha256:notes',
        truncated: false,
        size: 5,
        modifiedAt: null,
      })
    )
    const writeWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/README.md',
      name: 'README.md',
      content: 'hello world',
      editable: true,
      revision: 'sha256:saved',
      truncated: false,
      size: 11,
      modifiedAt: null,
    })

    render(
      <FileWorkspacePanel
        target={{
          deviceId: 'workspace-cloud-device',
          path: '/workspace/project',
          source: 'project',
          workspaceSource: 'remote',
        }}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile,
          writeWorkspaceTextFile,
        }}
        onAddCodeComment={vi.fn()}
      />
    )

    await user.click(await screen.findByText('README.md'))
    await user.click(screen.getByTestId('workspace-file-markdown-mode-button'))
    await replaceWorkspaceEditorText(
      await screen.findByTestId('workspace-file-editor'),
      'hello world'
    )
    await user.click(screen.getByText('notes.txt'))

    await waitFor(() =>
      expect(writeWorkspaceTextFile).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project/README.md',
        'hello world',
        'sha256:readme'
      )
    )
    expect(await screen.findByTestId('workspace-file-path')).toHaveTextContent(
      '/workspace/project/notes.txt'
    )
    expect(screen.queryByTestId('workspace-file-unsaved-dialog')).not.toBeInTheDocument()
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

  test('submits an empty environment commit message so AI can generate it', async () => {
    mockDesktopWorkbenchMainWidth(1024)
    const onCommitEnvironmentChanges = vi.fn().mockResolvedValue(undefined)
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onCommitEnvironmentChanges={onCommitEnvironmentChanges}
        state={{
          ...baseProps.state,
          currentRuntimeTask: activeProjectRuntimeTask,
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

    await userEvent.click(await screen.findByTestId('environment-commit-button'))

    const confirmButton = screen.getByTestId('environment-confirm-commit-button')
    expect(confirmButton).toBeEnabled()
    await userEvent.click(confirmButton)

    await waitFor(() =>
      expect(onCommitEnvironmentChanges).toHaveBeenCalledWith(null, '', activeProjectRuntimeTarget)
    )
  })

  test('shows actionable failed and stale verification states in the Smart app preview', async () => {
    const { propsForTask, taskA } = createLocalRuntimeTaskPanelFixture()
    const installed = {
      id: 'verification-workbench',
      manifest: {
        name: 'verification-workbench',
        displayName: '验证工作台',
        version: '0.1.0',
        type: 'deepseek-harness-plugin-bundle' as const,
        description: 'Verification fixture',
        entry: { installPackage: 'packages/bundle/web-app', profile: 'verification-workbench' },
        requirements: { dsh: '0.1.0-rc.8', node: '>=22' },
      },
      packagePath: '/tmp/verification-workbench',
      sha256: 'd'.repeat(64),
      modelKey: null,
      resident: false,
      runtimeVersion: null,
      state: 'installed' as const,
      webUrl: null,
      error: null,
      source: 'linked' as const,
    }
    const running = {
      ...installed,
      state: 'running' as const,
      webUrl: 'http://127.0.0.1:43126/',
    }
    harnessAppMocks.list.mockResolvedValue([running])
    harnessAppMocks.start.mockResolvedValue(running)
    harnessAppMocks.inspectVerification.mockResolvedValue({
      schemaVersion: 1,
      status: 'failed',
      projectRoot: installed.packagePath,
      inputFingerprint: 'input',
      deliverableFingerprint: null,
      startedAt: '2026-09-04T00:00:00.000Z',
      finishedAt: '2026-09-04T00:00:01.000Z',
      stages: [],
      issues: [
        {
          code: 'runtime_selector_missing',
          stage: 'runtime',
          file: 'smart-app.contract.json',
          message: 'The ready selector was not found',
          expected: '[data-testid="app-ready"]',
          actual: null,
          blocking: true,
          hint: 'Add the stable ready selector to the client root.',
        },
        {
          code: 'artifact_missing',
          stage: 'artifacts',
          file: 'dist/client.js',
          message: 'Missing client artifact',
          expected: null,
          actual: null,
          blocking: true,
          hint: 'Run the declared build script.',
        },
      ],
    })
    queueSmartAppDevelopmentPreview({
      installationId: installed.id,
      displayName: installed.manifest.displayName,
    })

    render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    await waitFor(() =>
      expect(
        screen.getByTestId('smart-app-development-preview-verification-failed')
      ).toHaveTextContent('智能工作台校验未通过，请修复后重新验证。')
    )
    expect(
      screen.getByTestId('smart-app-development-preview-verification-failed')
    ).toHaveTextContent('smart-app.contract.json')
    expect(
      screen.getByTestId('smart-app-development-preview-verification-failed')
    ).not.toHaveTextContent('Add the stable ready selector to the client root.')
    await userEvent.click(screen.getByTestId('smart-app-development-preview-verification-details'))
    expect(screen.getByText('artifact_missing')).toBeInTheDocument()

    harnessAppMocks.inspectVerification.mockResolvedValue({
      schemaVersion: 1,
      status: 'stale',
      projectRoot: installed.packagePath,
      inputFingerprint: 'changed-input',
      deliverableFingerprint: 'previous-delivery',
      startedAt: '2026-09-04T00:00:00.000Z',
      finishedAt: '2026-09-04T00:00:01.000Z',
      stages: [],
      issues: [],
    })
    await userEvent.click(screen.getByTestId('smart-app-development-preview-reload'))
    await waitFor(() =>
      expect(
        screen.getByTestId('smart-app-development-preview-verification-stale')
      ).toHaveTextContent('验证已过期')
    )
  }, 10_000)

  test('keeps an inactive Smart app preview from reclaiming the browser after switching tasks', async () => {
    const { propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()
    const installed = {
      id: 'task-scoped-workbench',
      manifest: {
        name: 'task-scoped-workbench',
        displayName: '任务内工作台',
        version: '0.1.0',
        type: 'deepseek-harness-plugin-bundle' as const,
        description: 'Web preset',
        entry: {
          installPackage: 'packages/bundle/web-app',
          profile: 'task-scoped-workbench',
        },
        requirements: { dsh: '0.1.0-rc.8', node: '>=22' },
      },
      packagePath: '/tmp/task-scoped-workbench',
      sha256: 'c'.repeat(64),
      modelKey: null,
      resident: false,
      runtimeVersion: null,
      state: 'installed' as const,
      webUrl: null,
      error: null,
      source: 'linked' as const,
    }
    const running = {
      ...installed,
      state: 'running' as const,
      webUrl: 'http://127.0.0.1:43125/',
    }
    const start = createDeferred<typeof running>()
    harnessAppMocks.list.mockResolvedValue([installed])
    harnessAppMocks.start.mockImplementation(() => start.promise)
    queueSmartAppDevelopmentPreview({
      installationId: installed.id,
      displayName: installed.manifest.displayName,
    })

    const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    await waitFor(() =>
      expect(screen.getByTestId('smart-app-development-preview-starting')).toBeInTheDocument()
    )

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)

    expect(
      within(screen.getByTestId('desktop-workbench-main')).queryByTestId(
        'smart-app-development-preview'
      )
    ).not.toBeInTheDocument()

    embeddedBrowserMocks.setEmbeddedBrowserActiveTab.mockClear()
    await act(async () => {
      start.resolve(running)
      await start.promise
    })
    await waitFor(() => expect(harnessAppTabMocks.register).toHaveBeenCalledWith(running))
    expect(embeddedBrowserMocks.setEmbeddedBrowserActiveTab).not.toHaveBeenCalled()

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    await waitFor(() =>
      expect(
        within(screen.getByTestId('desktop-workbench-main')).getByTestId(
          'right-workspace-browser-tab-1'
        )
      ).toHaveTextContent(installed.manifest.displayName)
    )
    expect(
      within(screen.getByTestId('desktop-workbench-main')).getByTestId(
        'right-workspace-browser-tab-1-close-button'
      )
    ).toBeInTheDocument()
    expect(screen.getByTestId('smart-app-development-preview-add-plugins')).toBeEnabled()
    expect(screen.getByTestId('smart-app-development-preview-refresh')).toBeEnabled()
    expect(screen.getByTestId('smart-app-development-preview-reload')).toBeEnabled()
  })

  test('closes the Smart app browser and runtime when the development tab is disposed', async () => {
    const { propsForTask, taskA } = createLocalRuntimeTaskPanelFixture()
    const workspaceTab = {
      id: 'smart-app-development-tab',
      kind: 'task' as const,
      title: '智能工作台开发',
      contentRoute: '/',
      fixed: false,
    }
    const workspaceTabs = {
      tabs: [workspaceTab],
      activeTabId: workspaceTab.id,
      activeTab: workspaceTab,
      openTab: vi.fn(),
      selectTab: vi.fn(),
      closeTab: vi.fn(),
      closeOtherTabs: vi.fn(),
      restoreClosedTab: vi.fn(),
      moveTab: vi.fn(),
      updateTab: vi.fn(),
      updateActiveTab: vi.fn(),
    } satisfies WorkspaceTabsContextValue
    const installed = {
      id: 'blank-workbench-disposal',
      manifest: {
        name: 'blank-workbench-disposal',
        displayName: '待关闭工作台',
        version: '0.1.0',
        type: 'deepseek-harness-plugin-bundle' as const,
        description: 'Web preset',
        entry: {
          installPackage: 'packages/bundle/web-app',
          profile: 'blank-workbench-disposal',
        },
        requirements: { dsh: '0.1.0-rc.8', node: '>=22' },
      },
      packagePath: '/tmp/blank-workbench-disposal',
      sha256: 'b'.repeat(64),
      modelKey: null,
      resident: false,
      runtimeVersion: null,
      state: 'installed' as const,
      webUrl: null,
      error: null,
      source: 'linked' as const,
    }
    const running = {
      ...installed,
      state: 'running' as const,
      webUrl: 'http://127.0.0.1:43124/',
    }
    harnessAppMocks.list.mockResolvedValue([installed])
    harnessAppMocks.start.mockResolvedValue(running)
    queueSmartAppDevelopmentPreview({
      installationId: installed.id,
      displayName: installed.manifest.displayName,
    })

    render(
      <WorkspaceTabsContext.Provider value={workspaceTabs}>
        <DesktopWorkbenchLayout {...propsForTask(taskA)} workspaceTabId={workspaceTab.id} />
      </WorkspaceTabsContext.Provider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute('src', running.webUrl)
    )
    embeddedBrowserMocks.closeEmbeddedBrowser.mockClear()
    harnessAppMocks.stop.mockClear()

    act(() => dispatchWorkspaceTabsClosed([workspaceTab.id]))

    await waitFor(() =>
      expect(embeddedBrowserMocks.closeEmbeddedBrowser).toHaveBeenCalledWith(
        expect.any(String),
        undefined
      )
    )
    await waitFor(() => expect(harnessAppMocks.stop).toHaveBeenCalledWith(installed.id))
    expect(screen.queryByTestId('smart-app-development-preview')).not.toBeInTheDocument()
  })

  test('exposes the task-scoped browser label before the browser panel mounts', () => {
    const { propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()
    const activePane = () => within(screen.getByTestId('desktop-workbench-main'))
    const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    expect(activePane().queryByTestId('workspace-browser-panel')).not.toBeInTheDocument()
    expect(activePane().getByTestId('desktop-workbench-content')).toHaveAttribute(
      'data-embedded-browser-label',
      'workspace-browser-runtime-a'
    )

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)

    expect(activePane().queryByTestId('workspace-browser-panel')).not.toBeInTheDocument()
    expect(activePane().getByTestId('desktop-workbench-content')).toHaveAttribute(
      'data-embedded-browser-label',
      'workspace-browser-runtime-b'
    )
  })

  test('reveals the workbench when its initial task list fails without claiming list readiness', async () => {
    runtimeMocks.electron = true
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          runtimeWork: null,
          runtimeWorkLoad: { phase: 'error', error: 'Local executor is unavailable' },
        }}
      />
    )
    await waitFor(() => {
      expect(desktopHostMocks.invoke).toHaveBeenCalledWith('renderer.startupReady', {
        source: 'task-list-error',
      })
    })
  })

  test('reveals the Electron startup window once the task list is ready', async () => {
    runtimeMocks.electron = true
    const { rerender } = render(
      <DesktopWorkbenchLayout {...baseProps} isRuntimeTranscriptLoading />
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(desktopHostMocks.invoke).not.toHaveBeenCalledWith('renderer.startupReady', {
      source: 'task-list',
    })

    rerender(
      <DesktopWorkbenchLayout
        {...baseProps}
        isRuntimeTranscriptLoading
        state={{
          ...baseProps.state,
          runtimeWork: {
            projects: [],
            chats: [],
            totalTasks: 0,
          },
        }}
      />
    )

    await waitFor(() => {
      expect(desktopHostMocks.invoke).toHaveBeenCalledWith('renderer.startupReady', {
        source: 'task-list',
      })
    })
  })

  test('reveals a blank workbench when the persisted startup pane no longer exists', async () => {
    runtimeMocks.electron = true
    localStorage.setItem(
      'wework:workbench-split-groups:v3:fixed-task',
      JSON.stringify({
        version: 3,
        state: {
          version: 3,
          groups: [],
          activeView: {
            type: 'single',
            layout: {
              version: 2,
              root: {
                id: 'stale-startup-pane',
                type: 'pane',
                paneKey: 'runtime:old-device:missing-task',
              },
              focusedPaneId: 'stale-startup-pane',
            },
          },
        },
      })
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceTabId="fixed-task"
        state={{
          ...baseProps.state,
          runtimeWork: {
            projects: [],
            chats: [],
            totalTasks: 0,
          },
        }}
      />
    )

    expect(await screen.findByTestId('desktop-workbench-main')).toBeInTheDocument()
    await waitFor(() => {
      expect(desktopHostMocks.invoke).toHaveBeenCalledWith('renderer.startupReady', {
        source: 'task-list',
      })
    })
    expect(localStorage.getItem('wework:workbench-split-groups:v3:fixed-task')).toContain(
      'runtime:old-device:missing-task'
    )
  })

  test.each([false, true])(
    'opens the requested new task instead of the restored conversation (request before mount: %s)',
    async requestBeforeMount => {
      const { propsForTask, taskA } = createLocalRuntimeTaskPanelFixture()
      const props = propsForTask(taskA)
      const workspaceTabId = 'new-task-navigation'
      const paneKey = `runtime:${taskA.deviceId}:${taskA.taskId}`
      localStorage.setItem(
        workbenchSplitStorageKeys(workspaceTabId).storageKey,
        serializeWorkbenchSplitGroups(createWorkbenchSplitGroupsState(paneKey))
      )
      if (requestBeforeMount) requestNewChatComposerFocus(workspaceTabId)
      render(
        <DesktopWorkbenchLayout
          {...props}
          workspaceTabId={workspaceTabId}
          state={{ ...props.state, currentRuntimeTask: null }}
        />
      )
      if (!requestBeforeMount) {
        expect(screen.queryByTestId('composer-plugin-picker-button')).not.toBeInTheDocument()
        act(() => requestNewChatComposerFocus('another-tab'))
        expect(screen.queryByTestId('composer-plugin-picker-button')).not.toBeInTheDocument()
        expect(consumeNewChatComposerRequest('another-tab')).toBe(true)
        act(() => requestNewChatComposerFocus(workspaceTabId))
      }
      expect(await screen.findByTestId('desktop-empty-composer-frame')).toBeInTheDocument()
      expect(screen.getByTestId('composer-plugin-picker-button')).toBeVisible()
      expect(consumeNewChatComposerRequest(workspaceTabId)).toBe(false)
    }
  )

  test('does not reveal an inactive project-space surface during startup', async () => {
    runtimeMocks.electron = true
    deliveryApiMock.available = true
    window.history.pushState({}, '', '/todo')
    const props = {
      ...baseProps,
      surfaceKind: 'board' as const,
      state: {
        ...baseProps.state,
        user: {
          id: 1,
          user_name: 'local',
          email: 'local@example.com',
        },
      },
    }
    const { rerender } = render(<DesktopWorkbenchLayout {...props} routeActive={false} />)

    await waitFor(() => {
      expect(deliveryApiMock.listCloudProjects).toHaveBeenCalled()
    })
    expect(desktopHostMocks.invoke).not.toHaveBeenCalledWith('renderer.startupReady')

    rerender(<DesktopWorkbenchLayout {...props} routeActive />)

    await waitFor(() => {
      expect(desktopHostMocks.invoke).toHaveBeenCalledWith('renderer.startupReady')
    })
  })

  test('does not reuse a migrated default browser label after switching panes', async () => {
    runtimeMocks.electron = true
    const browser = await import('@/lib/embedded-browser')
    const listen = browser.listenEmbeddedBrowserOpenRequests
    const releaseSubscriptions: (() => void)[] = []
    // Keep native subscription setup pending across the pane switch.
    const subscription = vi
      .spyOn(browser, 'listenEmbeddedBrowserOpenRequests')
      .mockImplementation(handler => {
        const listener = listen(handler)
        return (
          listener?.then(
            unlisten =>
              new Promise<typeof unlisten>(resolve => {
                releaseSubscriptions.push(() => resolve(unlisten))
              })
          ) ?? null
        )
      })
    const { propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture(2)
    desktopHostMocks.invoke.mockClear()
    const { rerender, unmount } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    try {
      await waitFor(() => {
        expect(requestEmbeddedBrowserOpen('https://example.com/')).toBe(true)
      })
      await waitFor(() => {
        expect(desktopHostMocks.invoke).toHaveBeenCalledWith(
          'browser.open',
          expect.objectContaining({
            label: 'workspace-browser-runtime-a',
            url: 'https://example.com/',
          })
        )
      })

      rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)

      await waitFor(() => {
        expect(requestEmbeddedBrowserOpen('https://example.org/')).toBe(true)
      })
      await waitFor(() => {
        expect(desktopHostMocks.invoke).toHaveBeenCalledWith(
          'browser.open',
          expect.objectContaining({
            label: 'workspace-browser-runtime-b',
            url: 'https://example.org/',
          })
        )
      })
      expect(desktopHostMocks.invoke).not.toHaveBeenCalledWith(
        'browser.open',
        expect.objectContaining({
          label: expect.stringMatching(/^workspace-browser-runtime-a(?:-|$)/),
          url: 'https://example.org/',
        })
      )
    } finally {
      unmount()
      releaseSubscriptions.forEach(release => release())
      subscription.mockRestore()
      await new Promise(resolve => setTimeout(resolve, 1_100))
    }
  }, 10_000)

  test('opens an embedded browser requested by an inactive runtime task', async () => {
    runtimeMocks.electron = true
    const { propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()
    const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)
    desktopHostMocks.invoke.mockClear()

    act(() => {
      desktopHostMocks.emit({
        sequence: 1,
        type: 'browser.event',
        payload: {
          sequence: 1,
          type: 'open-request',
          payload: {
            id: 'agent-open-inactive-task',
            baseLabel: 'workspace-browser-runtime-a',
            source: 'agent',
            disposition: 'current-tab',
            targetLabel: 'workspace-browser-runtime-a',
            label: 'workspace-browser-runtime-a',
            url: 'https://example.com/',
          },
        },
      })
    })

    await waitFor(() => {
      expect(desktopHostMocks.invoke).toHaveBeenCalledWith(
        'browser.open',
        expect.objectContaining({
          label: 'workspace-browser-runtime-a',
          url: 'about:blank',
          visible: false,
        })
      )
    })
    expect(desktopHostMocks.invoke).not.toHaveBeenCalledWith(
      'browser.open',
      expect.objectContaining({
        label: 'workspace-browser-runtime-b',
      })
    )
  })

  test('opens an embedded browser requested by the active blank pane', async () => {
    runtimeMocks.electron = true
    render(<DesktopWorkbenchLayout {...baseProps} />)
    desktopHostMocks.invoke.mockClear()

    act(() => {
      desktopHostMocks.emit({
        sequence: 1,
        type: 'browser.event',
        payload: {
          sequence: 1,
          type: 'open-request',
          payload: {
            id: 'agent-open-blank-pane',
            baseLabel: 'workspace-browser-blank-0',
            source: 'agent',
            disposition: 'current-tab',
            targetLabel: 'workspace-browser-blank-0',
            label: 'workspace-browser-blank-0',
            url: 'https://example.com/',
          },
        },
      })
    })

    await waitFor(() => {
      expect(desktopHostMocks.invoke).toHaveBeenCalledWith(
        'browser.open',
        expect.objectContaining({
          label: 'workspace-browser-blank-0',
          url: 'about:blank',
        })
      )
    })
  })

  test('restores serializable right workspace state without retaining the conversation pane', async () => {
    const { propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()
    const activePane = () => within(screen.getByTestId('desktop-workbench-main'))
    const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    await userEvent.click(activePane().getByTestId('toggle-right-workspace-panel-button'))
    expect(activePane().getByTestId('right-workspace-launcher')).toBeInTheDocument()

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)
    await waitFor(() =>
      expect(activePane().queryByTestId('right-workspace-panel')).not.toBeInTheDocument()
    )

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    await waitFor(() => {
      expect(activePane().getByTestId('right-workspace-panel-shell')).toHaveAttribute(
        'aria-hidden',
        'false'
      )
      expect(activePane().getByTestId('right-workspace-launcher')).toBeInTheDocument()
    })
  }, 10_000)

  test('omits the device surface add-menu item when the extension is unavailable', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('workspace-terminal-new-tab-button'))

    const menu = screen.getByTestId('workspace-terminal-new-tab-menu')
    expect(within(menu).getByTestId('workspace-add-terminal-option')).toBeInTheDocument()
    expect(within(menu).queryByTestId('workspace-add-ide-option')).not.toBeInTheDocument()
    expect(
      within(menu).queryByTestId('workspace-add-device-surface-option')
    ).not.toBeInTheDocument()
  })
})
