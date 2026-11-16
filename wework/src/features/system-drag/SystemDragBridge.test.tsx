import '@/i18n'
import { publishSelectedTextSelection, SELECTED_TEXT_DRAG_TYPE } from '@/lib/selected-text-drag'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SystemDragBridge } from './SystemDragBridge'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  pending: [] as Array<{ action: string; text: string | null; paths: string[] }>,
  setInput: vi.fn(),
  setWorkbenchError: vi.fn(),
  handleFileSelect: vi.fn(),
  startNewChat: vi.fn(),
  getAppPreferences: vi.fn(),
  updateAppPreferences: vi.fn(),
  resolveStoredPaths: vi.fn(),
  currentTask: null as { title: string } | null,
  workspaceSource: 'local' as 'local' | 'remote',
  input: '',
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: mocks.invoke,
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    state: {
      runtimeWork: [],
      currentRuntimeTask: mocks.currentTask ? 'task-1' : null,
    },
    projectChat: {
      input: mocks.input,
      setInput: mocks.setInput,
      handleFileSelect: mocks.handleFileSelect,
    },
    startNewChat: mocks.startNewChat,
    setWorkbenchError: mocks.setWorkbenchError,
  }),
}))
vi.mock('@/features/workbench/workbenchRuntimeHelpers', () => ({
  findRuntimeTask: () => mocks.currentTask,
  findRuntimeTaskWorkspace: () =>
    mocks.currentTask ? { workspaceSource: mocks.workspaceSource } : null,
}))
vi.mock('@/lib/workspace-path-transfer', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/workspace-path-transfer')>()),
  resolveStoredWorkspacePaths: mocks.resolveStoredPaths,
}))
vi.mock('@/desktop/appPreferences', () => ({
  APP_PREFERENCES_CHANGED_EVENT: 'wework:app-preferences-changed',
  getAppPreferences: mocks.getAppPreferences,
  updateAppPreferences: mocks.updateAppPreferences,
}))

function emitDrop(payload: { action: string; text: string | null; paths: string[] }) {
  act(() => {
    mocks.pending.push(payload)
  })
}

describe('SystemDragBridge', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    mocks.pending = []
    mocks.invoke.mockReset()
    mocks.setInput.mockReset()
    mocks.handleFileSelect.mockReset()
    mocks.startNewChat.mockReset()
    mocks.getAppPreferences.mockReset()
    mocks.updateAppPreferences.mockReset()
    mocks.getAppPreferences.mockResolvedValue({
      systemDragEnabled: true,
      quickPhrases: [],
    })
    mocks.resolveStoredPaths.mockReset()
    mocks.resolveStoredPaths.mockResolvedValue({
      attachmentFiles: [],
      referenceEntries: [],
    })
    mocks.currentTask = null
    mocks.workspaceSource = 'local'
    mocks.input = ''
    mocks.invoke.mockImplementation(command =>
      Promise.resolve(command === 'systemDrag.takePending' ? mocks.pending.splice(0) : undefined)
    )
  })

  test('handles rejected panel dismissal after a drag ends', async () => {
    const error = new Error('dismiss failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.invoke.mockImplementation(command => {
      if (command === 'systemDrag.takePending') return Promise.resolve(mocks.pending.splice(0))
      if (command === 'systemDrag.dismissPanel') return Promise.reject(error)
      return Promise.resolve(undefined)
    })
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.getAppPreferences).toHaveBeenCalled())
    const event = new Event('dragstart', { bubbles: true }) as DragEvent
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types: [SELECTED_TEXT_DRAG_TYPE, 'text/plain'],
        getData: (type: string) => (type === 'text/plain' ? 'selected text' : 'true'),
      },
    })

    act(() => {
      document.body.dispatchEvent(event)
      document.body.dispatchEvent(new Event('dragend', { bubbles: true }))
    })

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        '[Wework] Failed to dismiss system drag panel:',
        error
      )
    )
  })

  test('handles rejected panel dismissal when system drag is disabled', async () => {
    const error = new Error('dismiss failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.invoke.mockImplementation(command => {
      if (command === 'systemDrag.takePending') return Promise.resolve(mocks.pending.splice(0))
      if (command === 'systemDrag.dismissPanel') return Promise.reject(error)
      return Promise.resolve(undefined)
    })
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.getAppPreferences).toHaveBeenCalled())

    act(() => {
      window.dispatchEvent(
        new CustomEvent('wework:app-preferences-changed', {
          detail: { systemDragEnabled: false, quickPhrases: [] },
        })
      )
    })

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        '[Wework] Failed to dismiss system drag panel:',
        error
      )
    )
  })

  test('keeps managed selection actions while its rendered rectangle is temporarily unavailable', async () => {
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.getAppPreferences).toHaveBeenCalled())

    act(() => {
      publishSelectedTextSelection('workspace-preview:/workspace/index.ts', 'selected text', {
        left: 100,
        top: 200,
        width: 80,
        height: 20,
      })
    })
    expect(await screen.findByTestId('workspace-selection-actions')).toBeInTheDocument()

    act(() => {
      publishSelectedTextSelection('workspace-preview:/workspace/index.ts', 'selected text')
    })
    expect(screen.getByTestId('workspace-selection-actions')).toBeInTheDocument()
  })

  test('writes managed workspace selections when their drag source has no native selection data', async () => {
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.getAppPreferences).toHaveBeenCalled())
    const source = document.createElement('div')
    source.dataset.testid = 'workspace-file-preview'
    document.body.append(source)
    const values = new Map<string, string>()
    const dataTransfer = {
      types: [] as string[],
      effectAllowed: 'none',
      getData: (type: string) => values.get(type) ?? '',
      setData: (type: string, value: string) => {
        values.set(type, value)
        dataTransfer.types.push(type)
      },
    } as unknown as DataTransfer

    act(() => {
      publishSelectedTextSelection('workspace-preview:/workspace/index.ts', 'selected text', {
        left: 100,
        top: 200,
        width: 80,
        height: 20,
      })
    })
    await screen.findByTestId('workspace-selection-actions')

    act(() => {
      const event = new Event('dragstart', { bubbles: true }) as DragEvent
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      source.dispatchEvent(event)
    })

    expect(dataTransfer.getData('text/plain')).toBe('selected text')
    expect(dataTransfer.types).toContain(SELECTED_TEXT_DRAG_TYPE)
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.showPanel'))
  })

  test('dismisses stale workspace document actions when the selection becomes empty', async () => {
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.getAppPreferences).toHaveBeenCalled())
    const root = document.createElement('div')
    root.dataset.testid = 'workspace-file-preview'
    const textNode = document.createTextNode('selected text')
    root.append(textNode)
    document.body.append(root)
    let selectedText = 'selected text'
    vi.spyOn(document, 'getSelection').mockReturnValue({
      anchorNode: textNode,
      focusNode: textNode,
      getRangeAt: () => ({
        getBoundingClientRect: () => ({
          left: 100,
          top: 200,
          width: 80,
          height: 20,
        }),
      }),
      isCollapsed: false,
      rangeCount: 1,
      toString: () => selectedText,
    } as unknown as Selection)

    act(() => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })
    expect(await screen.findByTestId('workspace-selection-actions')).toBeInTheDocument()

    selectedText = '   '
    act(() => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })
    await waitFor(() =>
      expect(screen.queryByTestId('workspace-selection-actions')).not.toBeInTheDocument()
    )
  })

  test('reports a failed system file transfer', async () => {
    mocks.resolveStoredPaths.mockRejectedValue(new Error('File unavailable'))
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.takePending'))
    emitDrop({ action: 'new-chat', text: null, paths: ['/tmp/test.md'] })
    await waitFor(() => expect(mocks.setWorkbenchError).toHaveBeenCalledWith('File unavailable'))
    expect(mocks.handleFileSelect).not.toHaveBeenCalled()
  })
})
