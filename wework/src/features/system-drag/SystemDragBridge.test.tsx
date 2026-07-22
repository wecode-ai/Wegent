import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SystemDragBridge } from './SystemDragBridge'

const mocks = vi.hoisted(() => ({
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(),
  emitTo: vi.fn(),
  setInput: vi.fn(),
  handleFileSelect: vi.fn(),
  startNewChat: vi.fn(),
  getAppPreferences: vi.fn(),
  updateAppPreferences: vi.fn(),
  currentTask: null as { title: string } | null,
  input: '',
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: mocks.emitTo,
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.eventHandlers.set(name, handler)
    return Promise.resolve(() => undefined)
  }),
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
}))
vi.mock('@/tauri/droppedFiles', () => ({ readDroppedFiles: vi.fn(() => Promise.resolve([])) }))
vi.mock('@/tauri/appPreferences', () => ({
  getAppPreferences: mocks.getAppPreferences,
  updateAppPreferences: mocks.updateAppPreferences,
}))

function emitDrop(payload: { action: string; text: string | null; paths: string[] }) {
  act(() => {
    mocks.eventHandlers.get('wework-system-drag-drop')?.({ payload })
  })
}

describe('SystemDragBridge', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    mocks.eventHandlers.clear()
    mocks.invoke.mockReset()
    mocks.emitTo.mockReset()
    mocks.setInput.mockReset()
    mocks.handleFileSelect.mockReset()
    mocks.startNewChat.mockReset()
    mocks.getAppPreferences.mockReset()
    mocks.updateAppPreferences.mockReset()
    mocks.currentTask = null
    mocks.input = ''
    mocks.invoke.mockImplementation(command =>
      Promise.resolve(command === 'take_pending_system_drag_drops' ? [] : undefined)
    )
    mocks.emitTo.mockResolvedValue(undefined)
  })

  test('appends text to an existing new-chat draft', async () => {
    mocks.input = '已有草稿'
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.eventHandlers.has('wework-system-drag-drop')).toBe(true))

    emitDrop({ action: 'new-chat', text: '拖入内容', paths: [] })

    await waitFor(() => expect(mocks.setInput).toHaveBeenCalledWith('已有草稿\n拖入内容'))
  })

  test('does not carry conversation input into a new draft', async () => {
    mocks.currentTask = { title: '当前对话' }
    mocks.input = '旧对话未发送内容'
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.eventHandlers.has('wework-system-drag-drop')).toBe(true))

    emitDrop({ action: 'new-chat', text: '新草稿内容', paths: [] })

    expect(mocks.startNewChat).toHaveBeenCalled()
    await waitFor(() => expect(mocks.setInput).toHaveBeenCalledWith('新草稿内容'))
  })

  test('appends follow-up text to the current conversation draft', async () => {
    mocks.currentTask = { title: '当前对话' }
    mocks.input = '已有追问'
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.eventHandlers.has('wework-system-drag-drop')).toBe(true))

    emitDrop({ action: 'follow-up', text: '补充内容', paths: [] })

    await waitFor(() => expect(mocks.setInput).toHaveBeenCalledWith('已有追问\n补充内容'))
    expect(mocks.startNewChat).not.toHaveBeenCalled()
  })

  test('records when system-drag content is stashed', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_784_619_672_000)
    mocks.getAppPreferences.mockResolvedValue({
      quickPhrases: [{ id: 'summary', title: '总结进展', content: '总结当前进展', mode: 'normal' }],
    })
    mocks.updateAppPreferences.mockResolvedValue(undefined)
    render(<SystemDragBridge />)
    await waitFor(() => expect(mocks.eventHandlers.has('wework-system-drag-drop')).toBe(true))

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
