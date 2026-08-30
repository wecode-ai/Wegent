import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { publishSelectedTextSelection, SELECTED_TEXT_DRAG_TYPE } from '@/lib/selected-text-drag'
import { WORKSPACE_PATH_DRAG_TYPE, writeWorkspacePathDragData } from '@/lib/workspace-path-transfer'
import { SystemDragBridge } from './SystemDragBridge'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  pending: [] as Array<{ action: string; text: string | null; paths: string[] }>,
  setInput: vi.fn(),
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

  test('shows and dismisses the system panel for selected text drags', async () => {
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.getAppPreferences).toHaveBeenCalled())
    const dataTransfer = {
      types: [SELECTED_TEXT_DRAG_TYPE, 'text/plain'],
      getData: (type: string) => (type === 'text/plain' ? 'selected text' : 'true'),
    }

    act(() => {
      const event = new Event('dragstart', { bubbles: true }) as DragEvent
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      document.body.dispatchEvent(event)
    })
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.showPanel'))

    act(() => {
      document.body.dispatchEvent(new Event('dragend', { bubbles: true }))
    })
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.dismissPanel'))
  })

  test('dismisses the system panel after an in-flight show completes during cleanup', async () => {
    let resolveShow: (() => void) | undefined
    mocks.invoke.mockImplementation(command => {
      if (command === 'systemDrag.takePending') return Promise.resolve(mocks.pending.splice(0))
      if (command === 'systemDrag.showPanel') {
        return new Promise<void>(resolve => {
          resolveShow = resolve
        })
      }
      return Promise.resolve(undefined)
    })
    const view = render(<SystemDragBridge />)
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
    })
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.showPanel'))
    view.unmount()
    expect(mocks.invoke).not.toHaveBeenCalledWith('systemDrag.dismissPanel')

    await act(async () => {
      resolveShow?.()
    })
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.dismissPanel'))
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

  test('does not open the system drag panel until a selected-text drag starts', async () => {
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.getAppPreferences).toHaveBeenCalled())

    act(() => {
      publishSelectedTextSelection('workspace-editor:/workspace/index.ts', 'selected text', {
        left: 100,
        top: 200,
        width: 80,
        height: 20,
      })
    })
    expect(await screen.findByTestId('workspace-selection-actions')).toBeInTheDocument()
    expect(mocks.invoke).not.toHaveBeenCalledWith('systemDrag.showPanel')
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

  test('offers selection actions for Markdown workspace previews', async () => {
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.getAppPreferences).toHaveBeenCalled())
    const root = document.createElement('div')
    root.dataset.testid = 'workspace-markdown-preview'
    const textNode = document.createTextNode('selected markdown')
    root.append(textNode)
    document.body.append(root)
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 200,
      right: 180,
      bottom: 220,
      width: 80,
      height: 20,
      x: 100,
      y: 200,
      toJSON: () => ({}),
    })
    vi.spyOn(document, 'getSelection').mockReturnValue({
      anchorNode: textNode,
      focusNode: textNode,
      getRangeAt: () => ({
        getBoundingClientRect: () => ({
          left: 0,
          top: 0,
          width: 0,
          height: 0,
        }),
      }),
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'selected markdown',
    } as unknown as Selection)

    act(() => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })

    expect(await screen.findByTestId('workspace-selection-actions')).toBeInTheDocument()
  })

  test('keeps captured workspace document actions across a transient selectionchange', async () => {
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.getAppPreferences).toHaveBeenCalled())
    const root = document.createElement('div')
    root.dataset.testid = 'workspace-markdown-preview'
    const textNode = document.createTextNode('selected markdown')
    root.append(textNode)
    document.body.append(root)
    let selectionActive = true
    vi.spyOn(document, 'getSelection').mockImplementation(
      () =>
        ({
          anchorNode: selectionActive ? textNode : null,
          focusNode: selectionActive ? textNode : null,
          getRangeAt: () => ({
            getBoundingClientRect: () => ({
              left: 100,
              top: 200,
              width: 80,
              height: 20,
            }),
          }),
          isCollapsed: !selectionActive,
          rangeCount: selectionActive ? 1 : 0,
          toString: () => (selectionActive ? 'selected markdown' : ''),
        }) as unknown as Selection
    )

    act(() => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })
    expect(await screen.findByTestId('workspace-selection-actions')).toBeInTheDocument()

    selectionActive = false
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })

    await waitFor(() =>
      expect(screen.getByTestId('workspace-selection-actions')).toBeInTheDocument()
    )
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

  test('adds a managed text selection to the current composer draft', async () => {
    const user = userEvent.setup()
    mocks.input = 'existing draft'
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.getAppPreferences).toHaveBeenCalled())

    act(() => {
      publishSelectedTextSelection('workspace-editor:/workspace/index.ts', 'selected text', {
        left: 100,
        top: 200,
        width: 80,
        height: 20,
      })
    })

    await user.click(await screen.findByTestId('add-workspace-selection-to-conversation-button'))
    expect(mocks.setInput).toHaveBeenCalledWith('existing draft\nselected text')
    expect(screen.queryByTestId('workspace-selection-actions')).not.toBeInTheDocument()
  })

  test('dismisses managed selection actions when their source clears', async () => {
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.getAppPreferences).toHaveBeenCalled())

    act(() => {
      publishSelectedTextSelection('terminal:test', 'terminal text', {
        left: 100,
        top: 200,
        width: 80,
        height: 20,
      })
    })
    expect(await screen.findByTestId('workspace-selection-actions')).toBeInTheDocument()

    act(() => {
      publishSelectedTextSelection('terminal:test', null)
    })
    expect(screen.queryByTestId('workspace-selection-actions')).not.toBeInTheDocument()
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

  test('does not show the system panel when selected text drag is disabled', async () => {
    mocks.getAppPreferences.mockResolvedValue({
      systemDragEnabled: false,
      quickPhrases: [],
    })
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.getAppPreferences).toHaveBeenCalled())

    act(() => {
      const event = new Event('dragstart', { bubbles: true }) as DragEvent
      Object.defineProperty(event, 'dataTransfer', {
        value: {
          types: [SELECTED_TEXT_DRAG_TYPE, 'text/plain'],
          getData: (type: string) => (type === 'text/plain' ? 'selected text' : 'true'),
        },
      })
      document.body.dispatchEvent(event)
    })

    expect(mocks.invoke).not.toHaveBeenCalledWith('systemDrag.showPanel')
  })

  test('does not show the system panel before drag preferences load', async () => {
    let resolvePreferences:
      | ((preferences: { systemDragEnabled: boolean; quickPhrases: never[] }) => void)
      | undefined
    mocks.getAppPreferences.mockReturnValue(
      new Promise(resolve => {
        resolvePreferences = resolve
      })
    )
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.getAppPreferences).toHaveBeenCalled())

    const dispatchSelectedTextDrag = () => {
      const event = new Event('dragstart', { bubbles: true }) as DragEvent
      Object.defineProperty(event, 'dataTransfer', {
        value: {
          types: [SELECTED_TEXT_DRAG_TYPE, 'text/plain'],
          getData: (type: string) => (type === 'text/plain' ? 'selected text' : 'true'),
        },
      })
      document.body.dispatchEvent(event)
    }
    act(dispatchSelectedTextDrag)
    expect(mocks.invoke).not.toHaveBeenCalledWith('systemDrag.showPanel')

    await act(async () => {
      resolvePreferences?.({ systemDragEnabled: true, quickPhrases: [] })
    })
    act(dispatchSelectedTextDrag)
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.showPanel'))
  })

  test('shows the system panel for workspace file drags', async () => {
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.getAppPreferences).toHaveBeenCalled())
    const values = new Map<string, string>()
    const dataTransfer = {
      types: [] as string[],
      getData: (type: string) => values.get(type) ?? '',
      setData: (type: string, value: string) => {
        values.set(type, value)
        dataTransfer.types.push(type)
      },
    } as unknown as DataTransfer
    writeWorkspacePathDragData(dataTransfer, [{ path: '/workspace/README.md', isDirectory: false }])

    act(() => {
      const event = new Event('dragstart', { bubbles: true }) as DragEvent
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      document.body.dispatchEvent(event)
    })

    expect(dataTransfer.types).toContain(WORKSPACE_PATH_DRAG_TYPE)
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.showPanel'))
  })

  test('appends text to an existing new-chat draft', async () => {
    mocks.input = '已有草稿'
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.takePending'))

    emitDrop({ action: 'new-chat', text: '拖入内容', paths: [] })

    await waitFor(() => expect(mocks.setInput).toHaveBeenCalledWith('已有草稿\n拖入内容'))
  })

  test('does not carry conversation input into a new draft', async () => {
    mocks.currentTask = { title: '当前对话' }
    mocks.input = '旧对话未发送内容'
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.takePending'))

    emitDrop({ action: 'new-chat', text: '新草稿内容', paths: [] })

    await waitFor(() => expect(mocks.startNewChat).toHaveBeenCalled())
    await waitFor(() => expect(mocks.setInput).toHaveBeenCalledWith('新草稿内容'))
  })

  test('appends follow-up text to the current conversation draft', async () => {
    mocks.currentTask = { title: '当前对话' }
    mocks.input = '已有追问'
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.takePending'))

    emitDrop({ action: 'follow-up', text: '补充内容', paths: [] })

    await waitFor(() => expect(mocks.setInput).toHaveBeenCalledWith('已有追问\n补充内容'))
    expect(mocks.startNewChat).not.toHaveBeenCalled()
  })

  test('adds dropped folders and ordinary files as path references without reading them', async () => {
    mocks.resolveStoredPaths.mockResolvedValue({
      attachmentFiles: [],
      referenceEntries: [
        { path: '/tmp/project', isDirectory: true },
        { path: '/tmp/project/README.md', isDirectory: false },
      ],
    })
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.takePending'))

    emitDrop({
      action: 'new-chat',
      text: null,
      paths: ['/tmp/project', '/tmp/project/README.md'],
    })

    await waitFor(() =>
      expect(mocks.setInput).toHaveBeenCalledWith(
        '[$project](folder://%2Ftmp%2Fproject) [$README.md](file://%2Ftmp%2Fproject%2FREADME.md)'
      )
    )
    expect(mocks.resolveStoredPaths).toHaveBeenCalledWith(
      ['/tmp/project', '/tmp/project/README.md'],
      false
    )
    expect(mocks.handleFileSelect).not.toHaveBeenCalled()
  })

  test('reads only dropped images before attaching them', async () => {
    const image = new File(['image'], 'preview.png', { type: 'image/png' })
    mocks.resolveStoredPaths.mockResolvedValue({
      attachmentFiles: [image],
      referenceEntries: [{ path: '/tmp/project', isDirectory: true }],
    })
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.takePending'))

    emitDrop({
      action: 'new-chat',
      text: null,
      paths: ['/tmp/project', '/tmp/preview.png'],
    })

    await waitFor(() => expect(mocks.handleFileSelect).toHaveBeenCalledWith([image]))
    expect(mocks.resolveStoredPaths).toHaveBeenCalledWith(
      ['/tmp/project', '/tmp/preview.png'],
      false
    )
    expect(mocks.setInput).toHaveBeenCalledWith('[$project](folder://%2Ftmp%2Fproject)')
  })

  test('records when system-drag content is stashed', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_784_619_672_000)
    mocks.getAppPreferences.mockResolvedValue({
      quickPhrases: [{ id: 'summary', title: '总结进展', content: '总结当前进展', mode: 'normal' }],
    })
    mocks.updateAppPreferences.mockResolvedValue(undefined)
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.takePending'))

    emitDrop({ action: 'stash', text: '暂存的文本', paths: ['/tmp/image.png'] })

    await waitFor(() =>
      expect(mocks.updateAppPreferences).toHaveBeenCalledWith({
        quickPhrases: [
          {
            id: 'stash-1784619672000',
            title: '暂存的文本',
            content: '暂存的文本',
            mode: 'normal',
            attachmentPaths: ['/tmp/image.png'],
            createdAt: 1_784_619_672_000,
          },
          { id: 'summary', title: '总结进展', content: '总结当前进展', mode: 'normal' },
        ],
      })
    )
  })
})
