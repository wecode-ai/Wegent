import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { installDeveloperCommandMenu } from './developerCommandMenu'

const invokeMock = vi.hoisted(() => vi.fn())
const isTauriRuntimeMock = vi.hoisted(() => vi.fn())
const getWorkbenchDebugSnapshotMock = vi.hoisted(() => vi.fn())
const clearWorkbenchDebugLogsMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('./runtime-environment', () => ({
  isTauriRuntime: isTauriRuntimeMock,
}))

vi.mock('./debugPanel', () => ({
  clearWorkbenchDebugLogs: clearWorkbenchDebugLogsMock,
  getWorkbenchDebugSnapshot: getWorkbenchDebugSnapshotMock,
}))

describe('developerCommandMenu', () => {
  beforeAll(() => {
    installDeveloperCommandMenu()
  })

  beforeEach(() => {
    invokeMock.mockResolvedValue(undefined)
    isTauriRuntimeMock.mockReturnValue(true)
    getWorkbenchDebugSnapshotMock.mockReturnValue(createDebugSnapshot())
    localStorage.clear()
  })

  afterEach(() => {
    document.getElementById('wework-developer-command-menu')?.remove()
    document.getElementById('wework-debug-panel')?.remove()
    vi.clearAllMocks()
  })

  test('opens the command menu with the developer shortcut', () => {
    dispatchDeveloperShortcut()

    expect(screenCommand('reload')).toBeInTheDocument()
    expect(screenCommand('open-debug-panel')).toBeInTheDocument()
    expect(screenCommand('toggle-performance-diagnostics')).toBeInTheDocument()
    expect(screenCommand('print-performance-snapshot')).toBeInTheDocument()
    expect(screenCommand('open-log-directory')).toBeInTheDocument()
    expect(screenCommand('open-web-inspector')).toBeInTheDocument()
  })

  test('opens the app log directory through Tauri', () => {
    dispatchDeveloperShortcut()

    screenCommand('open-log-directory').click()

    expect(invokeMock).toHaveBeenCalledWith('open_app_log_directory')
  })

  test('opens the main WebView inspector through Tauri', () => {
    dispatchDeveloperShortcut()

    screenCommand('open-web-inspector').click()

    expect(invokeMock).toHaveBeenCalledWith('open_main_webview_devtools')
  })

  test('opens the debug panel with active task state and debug logs', () => {
    dispatchDeveloperShortcut()

    screenCommand('open-debug-panel').click()

    expect(document.getElementById('wework-debug-panel')).toBeInTheDocument()
    expect(document.body).toHaveTextContent('Active Task State (taskKnown=true')
    expect(document.body).toHaveTextContent('Transcript vs Streaming Style')
    expect(document.body).toHaveTextContent('"taskId": "task-1"')
    expect(document.body).toHaveTextContent('Transcript Loaded')
    expect(document.body).toHaveTextContent('Current Streaming')
    expect(document.body).toHaveTextContent('loaded transcript response')
    expect(document.body).toHaveTextContent('streaming response')
    expect(document.body).toHaveTextContent('[Wework] sample debug')
  })

  test('collapses and expands the debug panel', () => {
    dispatchDeveloperShortcut()
    screenCommand('open-debug-panel').click()

    screenButton('Collapse').click()

    expect(screenCollapsedDebugPanel()).toBeInTheDocument()
    expect(document.body).toHaveTextContent('Debug Panel collapsed')
    expect(document.body).not.toHaveTextContent('Transcript vs Streaming Style')

    screenCollapsedDebugPanel().click()

    expect(document.body).toHaveTextContent('Transcript vs Streaming Style')
    expect(document.body).toHaveTextContent('Collapse')
  })
})

function dispatchDeveloperShortcut() {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      code: 'KeyP',
      key: 'P',
      metaKey: true,
      altKey: true,
      shiftKey: true,
    })
  )
}

function screenCommand(commandId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="developer-command-${commandId}"]`
  )
  if (!element) {
    throw new Error(`Command was not found: ${commandId}`)
  }
  return element
}

function screenButton(label: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
  const button = buttons.find(item => item.textContent === label)
  if (!button) {
    throw new Error(`Button was not found: ${label}`)
  }
  return button
}

function screenCollapsedDebugPanel(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-testid="debug-panel-collapsed"]')
  if (!element) {
    throw new Error('Collapsed debug panel was not found')
  }
  return element
}

function createDebugSnapshot() {
  return {
    updatedAt: '2026-07-03T00:00:00.000Z',
    workbench: {
      isBootstrapping: false,
      error: null,
      currentProject: null,
      currentRuntimeTask: {
        deviceId: 'device-1',
        workspacePath: '/tmp/workspace',
        taskId: 'task-1',
      },
      currentRuntimeTaskRunning: true,
      runningState: {
        hasCurrentRuntimeTask: true,
        activeTaskKnown: true,
        activeTaskRunning: true,
        activeTaskStatus: 'running',
        providerRunning: true,
      },
      activeTask: {
        taskId: 'task-1',
        workspacePath: '/tmp/workspace',
        title: 'Debug task',
        runtime: 'codex',
        running: true,
        status: 'running',
      },
      activeWorkspace: null,
      runtimeWorkSummary: {
        totalTasks: 1,
        projectCount: 0,
        projectWorkspaceCount: 0,
        chatWorkspaceCount: 1,
        runningTaskCount: 1,
      },
      devices: [],
      standaloneDeviceId: null,
      standaloneWorkspacePath: null,
      selectedDeviceWorkspaceId: null,
      cloudWorkStatus: {
        availability: 'available',
        checks: {
          teams: 'available',
          devices: 'available',
          runtimeWork: 'available',
        },
        error: null,
        updatedAt: '2026-07-03T00:00:00.000Z',
      },
    },
    pane: {
      updatedAt: '2026-07-03T00:00:00.000Z',
      currentRuntimeTask: {
        deviceId: 'device-1',
        workspacePath: '/tmp/workspace',
        taskId: 'task-1',
      },
      status: {
        sendPhase: 'awaiting_assistant',
        activeAssistantMessage: null,
        taskExecution: {
          known: true,
          running: true,
          status: 'running',
        },
        isSubmitting: false,
        isAwaitingAssistant: true,
        isAssistantStreaming: true,
        isResponseActive: true,
        isBusy: true,
        isWaitingForAssistantIndicator: true,
        canSendQueuedMessage: false,
      },
      messageSummary: {
        total: 2,
        byRole: {
          assistant: 2,
        },
        byStatus: {
          done: 1,
          streaming: 1,
        },
        activeAssistantMessage: null,
        lastMessage: null,
      },
      messageStyleComparison: {
        transcriptLoaded: {
          label: 'Transcript loaded assistant message',
          id: 'loaded-1',
          role: 'assistant',
          status: 'done',
          runtimeStatus: 'done',
          runtimeMessageIndex: 1,
          subtaskId: 10,
          createdAt: '2026-07-03T00:00:00.000Z',
          completedAt: '2026-07-03T00:01:00.000Z',
          contentPreview: 'loaded transcript response',
          hasVisibleContent: true,
          blockCount: 1,
          runningBlockCount: 0,
          hasFileChanges: true,
          referenceCount: 1,
          memoryCitationCount: 0,
          expectedUi: ['MessageHoverActions available on hover'],
        },
        currentStreaming: {
          label: 'Current streaming assistant message',
          id: 'streaming-1',
          role: 'assistant',
          status: 'streaming',
          runtimeStatus: 'streaming',
          runtimeMessageIndex: null,
          subtaskId: 11,
          createdAt: '2026-07-03T00:02:00.000Z',
          completedAt: null,
          contentPreview: 'streaming response',
          hasVisibleContent: true,
          blockCount: 1,
          runningBlockCount: 1,
          hasFileChanges: false,
          referenceCount: 0,
          memoryCitationCount: 0,
          expectedUi: ['MessageHoverActions hidden while streaming'],
        },
        fieldDiff: [
          {
            field: 'status',
            transcriptLoaded: 'done',
            currentStreaming: 'streaming',
          },
        ],
        renderingRules: ['Streaming messages hide hover actions and suppress final artifacts.'],
      },
      queuedMessages: [],
      guidanceMessages: [],
      codeCommentContextCount: 0,
      inputLength: 0,
      transcript: {
        loading: false,
        hasMoreBefore: false,
        loadingMoreBefore: false,
        turnNavigationCount: 0,
      },
      subagentStatuses: [],
      goal: null,
      goalDraftActive: false,
    },
    logs: [
      {
        id: 1,
        timestamp: '2026-07-03T00:00:00.000Z',
        args: ['[Wework] sample debug'],
      },
    ],
    logLimit: 500,
  }
}
