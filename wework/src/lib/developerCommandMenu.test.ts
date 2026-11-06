import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { installDeveloperCommandMenu } from './developerCommandMenu'

const desktopInvokeMock = vi.hoisted(() => vi.fn())
const requestLocalExecutorMock = vi.hoisted(() => vi.fn())
const isElectronRuntimeMock = vi.hoisted(() => vi.fn())
const getWorkbenchDebugSnapshotMock = vi.hoisted(() => vi.fn())
const clearWorkbenchDebugLogsMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopInvokeMock,
}))

vi.mock('@/desktop/localExecutor', () => ({
  requestLocalExecutor: requestLocalExecutorMock,
}))

vi.mock('./runtime-environment', () => ({
  isElectronRuntime: isElectronRuntimeMock,
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
    desktopInvokeMock.mockResolvedValue(undefined)
    requestLocalExecutorMock.mockResolvedValue({ enabled: false })
    isElectronRuntimeMock.mockReturnValue(true)
    getWorkbenchDebugSnapshotMock.mockReturnValue(createDebugSnapshot())
    localStorage.clear()
  })

  afterEach(() => {
    document.getElementById('wework-developer-command-menu')?.remove()
    document.getElementById('wework-debug-panel')?.remove()
    vi.clearAllMocks()
  })

  test('toggles Codex stream logs through the local executor', async () => {
    requestLocalExecutorMock
      .mockResolvedValueOnce({ enabled: false })
      .mockResolvedValueOnce({ enabled: true })
    dispatchDeveloperShortcut()
    await flushPromises()

    screenCommand('toggle-stream-logs').click()
    await flushPromises()

    expect(requestLocalExecutorMock).toHaveBeenCalledWith('runtime.codex.stream_debug.get')
    expect(requestLocalExecutorMock).toHaveBeenCalledWith('runtime.codex.stream_debug.set', {
      enabled: true,
    })
    expect(localStorage.getItem('wework:debug-runtime-chat-stream')).toBe('1')
  })

  test('restores the frontend stream flag when the executor toggle fails', async () => {
    requestLocalExecutorMock
      .mockResolvedValueOnce({ enabled: true })
      .mockRejectedValueOnce(new Error('executor unavailable'))
    dispatchDeveloperShortcut()
    await flushPromises()

    screenCommand('toggle-stream-logs').click()
    await flushPromises()

    expect(localStorage.getItem('wework:debug-runtime-chat-stream')).toBeNull()
  })

  test('keeps debug actions usable across refresh, collapse, reopen and close', () => {
    dispatchDeveloperShortcut()
    screenCommand('open-debug-panel').click()

    const expandedPanelSelector = '#wework-debug-panel [role="dialog"]'
    expect(document.querySelector(expandedPanelSelector)).not.toBeNull()

    getWorkbenchDebugSnapshotMock.mockClear()
    screenDebugAction('refresh').click()
    expect(getWorkbenchDebugSnapshotMock).toHaveBeenCalledOnce()

    screenDebugAction('clear-logs').click()
    expect(clearWorkbenchDebugLogsMock).toHaveBeenCalledOnce()

    screenDebugAction('collapse').click()
    expect(document.querySelector(expandedPanelSelector)).toBeNull()

    screenDebugAction('collapsed').click()
    expect(document.querySelector(expandedPanelSelector)).not.toBeNull()

    screenDebugAction('close').click()
    expect(document.getElementById('wework-debug-panel')).toBeNull()
  })

  test('restores the collapsed panel after Escape or a backdrop click', () => {
    dispatchDeveloperShortcut()
    screenCommand('open-debug-panel').click()

    const panel = document.getElementById('wework-debug-panel')!
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector('#wework-debug-panel [role="dialog"]')).toBeNull()

    screenDebugAction('collapsed').click()
    panel.click()
    expect(document.querySelector('#wework-debug-panel [role="dialog"]')).toBeNull()
    expect(screenDebugAction('collapsed')).not.toBeNull()
  })
})

function screenDebugAction(action: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(`[data-testid="debug-panel-${action}"]`)
  if (!element) throw new Error(`Debug panel action was not found: ${action}`)
  return element
}

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

function flushPromises(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0))
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
      lifecycleCurrentTaskRunning: true,
      runningState: {
        hasCurrentRuntimeTask: true,
        activeTaskKnown: true,
        activeTaskRunning: true,
        activeTaskStatus: 'running',
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
          continuable: true,
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
      memory: {
        messages: {
          count: 2,
          contentChars: 41,
          blockCount: 2,
          toolBlockCount: 1,
          toolOutputApproxChars: 128,
          renderPayloadApproxChars: 0,
          attachmentCount: 0,
          attachmentPathChars: 0,
          referenceCount: 1,
          memoryCitationCount: 0,
          topToolOutputs: [
            {
              messageId: 'loaded-1',
              blockId: 'tool-1',
              toolName: 'bash',
              status: 'done',
              approxChars: 128,
              outputType: 'string',
            },
          ],
        },
        currentRuntimeTask: {
          hasRuntimeHandle: true,
          runtimeHandleKeys: ['messages'],
          runtimeHandleApproxChars: 256,
          runtimeHandleEstimateTruncated: false,
        },
        transcript: {
          loadedRangeCount: 1,
          loadedRanges: [{ start: 0, end: 50 }],
          loadedMessageSlots: 50,
        },
        dom: {
          messageNodes: 2,
          processingBlockNodes: 1,
          codeBlocks: 1,
        },
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
        beforeCursor: null,
        loadedRanges: [{ start: 0, end: 50 }],
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
