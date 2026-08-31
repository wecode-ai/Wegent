import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WORKSPACE_PATH_DRAG_TYPE, writeWorkspacePathDragData } from '@/lib/workspace-path-transfer'
import { SystemDragPanel } from './SystemDragPanel'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: mocks.invoke,
}))

describe('SystemDragPanel', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockImplementation((capability: string) =>
      Promise.resolve(
        capability === 'systemDrag.getContext' ? { conversationTitle: null } : undefined
      )
    )
  })

  test('identifies the panel as part of Wework', () => {
    render(<SystemDragPanel />)

    expect(screen.getByTestId('system-drag-brand')).toHaveTextContent('Wework')
    expect(screen.getByTestId('system-drag-panel')).toHaveClass('h-[60px]')
    expect(screen.getByTestId('system-drag-close-button')).toHaveAccessibleName('关闭')
  })

  test('closes manually without completing a drop', () => {
    render(<SystemDragPanel />)

    fireEvent.click(screen.getByTestId('system-drag-close-button'))

    expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.dismissPanel')
    expect(mocks.invoke).not.toHaveBeenCalledWith('systemDrag.complete', expect.anything())
  })

  test('closes on Escape without completing a drop', () => {
    render(<SystemDragPanel />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.dismissPanel')
    expect(mocks.invoke).not.toHaveBeenCalledWith('systemDrag.complete', expect.anything())
  })

  test('only shows follow-up when a conversation is selected', async () => {
    mocks.invoke.mockImplementation((capability: string) =>
      Promise.resolve(
        capability === 'systemDrag.getContext' ? { conversationTitle: '修复登录问题' } : undefined
      )
    )
    render(<SystemDragPanel />)

    expect(await screen.findByTestId('system-drag-follow-up-zone')).toHaveTextContent(
      '修复登录问题'
    )
    expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.getContext')
  })

  test('visually highlights a drop zone while dragging over it', () => {
    render(<SystemDragPanel />)
    const stashZone = screen.getByTestId('system-drag-stash-zone')
    const dataTransfer = { dropEffect: 'none' }

    fireEvent.dragOver(stashZone, { dataTransfer })

    expect(stashZone).toHaveClass('border-text-primary/15', 'bg-muted', 'shadow-sm')
    expect(stashZone).toHaveTextContent('松开即可添加')
    expect(dataTransfer.dropEffect).toBe('copy')
  })

  test('accepts dragged text through the browser drop event', async () => {
    render(<SystemDragPanel />)
    const newChatZone = screen.getByTestId('system-drag-new-chat-zone')

    fireEvent.drop(newChatZone, {
      dataTransfer: { getData: () => '拖入的文字' },
    })

    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.complete', {
        payload: { action: 'new-chat', text: '拖入的文字', paths: [] },
      })
    })
  })

  test('accepts dragged workspace paths through the browser drop event', async () => {
    render(<SystemDragPanel />)
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

    fireEvent.drop(screen.getByTestId('system-drag-new-chat-zone'), { dataTransfer })

    expect(dataTransfer.types).toContain(WORKSPACE_PATH_DRAG_TYPE)
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('systemDrag.complete', {
        payload: {
          action: 'new-chat',
          paths: ['/workspace/README.md'],
          text: null,
        },
      })
    )
  })
})
