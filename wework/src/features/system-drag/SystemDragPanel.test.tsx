import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { SystemDragPanel } from './SystemDragPanel'

const mocks = vi.hoisted(() => ({
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(),
  emit: vi.fn(),
  dragDropHandler: null as ((event: { payload: unknown }) => void) | null,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  emit: mocks.emit,
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.eventHandlers.set(name, handler)
    return Promise.resolve(() => undefined)
  }),
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (event: { payload: unknown }) => void) => {
      mocks.dragDropHandler = handler
      return Promise.resolve(() => undefined)
    },
  }),
}))

describe('SystemDragPanel', () => {
  beforeEach(() => {
    mocks.eventHandlers.clear()
    mocks.invoke.mockReset()
    mocks.emit.mockReset()
    mocks.dragDropHandler = null
    mocks.invoke.mockResolvedValue(undefined)
  })

  test('only shows follow-up when a conversation is selected', async () => {
    render(<SystemDragPanel />)

    expect(screen.queryByTestId('system-drag-follow-up-zone')).not.toBeInTheDocument()
    await vi.waitFor(() => expect(mocks.eventHandlers.has('wework-system-drag-context')).toBe(true))
    act(() => {
      mocks.eventHandlers.get('wework-system-drag-context')?.({
        payload: { conversationTitle: '修复登录问题' },
      })
    })

    expect(await screen.findByTestId('system-drag-follow-up-zone')).toHaveTextContent(
      '修复登录问题'
    )
  })

  test('shows success feedback after a Tauri file drop completes', async () => {
    render(<SystemDragPanel />)
    await vi.waitFor(() => expect(mocks.dragDropHandler).not.toBeNull())

    act(() => {
      mocks.dragDropHandler?.({
        payload: {
          type: 'drop',
          paths: ['/tmp/notes.txt', '/tmp/notes.txt'],
          position: { x: 20, y: 20 },
        },
      })
      mocks.dragDropHandler?.({
        payload: { type: 'drop', paths: ['/tmp/notes.txt'], position: { x: 24, y: 22 } },
      })
    })

    expect(await screen.findByTestId('system-drag-success-feedback')).toHaveTextContent('已添加')
    expect(mocks.invoke).toHaveBeenCalledWith('complete_system_drag_drop', {
      payload: { action: 'new-chat', text: null, paths: ['/tmp/notes.txt'] },
    })
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'complete_system_drag_drop')
    ).toHaveLength(1)
  })

  test('visually highlights a drop zone while dragging over it', () => {
    render(<SystemDragPanel />)
    const stashZone = screen.getByTestId('system-drag-stash-zone')

    fireEvent.dragOver(stashZone)

    expect(stashZone).toHaveClass('border-foreground/15', 'bg-muted', 'shadow-sm')
  })

  test('accepts dragged text through the browser drop event', async () => {
    render(<SystemDragPanel />)
    const newChatZone = screen.getByTestId('system-drag-new-chat-zone')

    fireEvent.drop(newChatZone, {
      dataTransfer: { getData: () => '拖入的文字' },
    })

    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('complete_system_drag_drop', {
        payload: { action: 'new-chat', text: '拖入的文字', paths: [] },
      })
    })
  })

  test('accepts browser text forwarded by the native drag pasteboard', async () => {
    render(<SystemDragPanel />)
    await vi.waitFor(() =>
      expect(mocks.eventHandlers.has('wework-system-drag-native-text-drop')).toBe(true)
    )

    act(() => {
      mocks.eventHandlers.get('wework-system-drag-native-text-drop')?.({
        payload: { text: '网页里的文字', x: 32 },
      })
      mocks.eventHandlers.get('wework-system-drag-native-text-drop')?.({
        payload: { text: '网页里的文字', x: 32 },
      })
    })

    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('complete_system_drag_drop', {
        payload: { action: 'new-chat', text: '网页里的文字', paths: [] },
      })
    })
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'complete_system_drag_drop')
    ).toHaveLength(1)
  })

  test('uses Tauri macOS coordinates without applying Retina scaling twice', async () => {
    render(<SystemDragPanel />)
    await vi.waitFor(() => expect(mocks.dragDropHandler).not.toBeNull())

    act(() => {
      mocks.dragDropHandler?.({ payload: { type: 'over', position: { x: 411, y: 107 } } })
    })

    expect(screen.getByTestId('system-drag-stash-zone')).toHaveClass(
      'border-foreground/15',
      'bg-muted'
    )
  })
})
