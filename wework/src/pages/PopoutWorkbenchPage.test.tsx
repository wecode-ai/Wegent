import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { PopoutWorkbenchPage } from './PopoutWorkbenchPage'

const dismissPopoutWindowMock = vi.hoisted(() => vi.fn())
const startDraggingMock = vi.hoisted(() => vi.fn())
const setPopoutWindowExpandedMock = vi.hoisted(() => vi.fn())
const setPopoutWindowOverlayActiveMock = vi.hoisted(() => vi.fn())
const openPopoutTaskInMainMock = vi.hoisted(() => vi.fn())
const selectProjectMock = vi.hoisted(() => vi.fn())
const selectStandaloneDeviceMock = vi.hoisted(() => vi.fn())
const setWorkbenchErrorMock = vi.hoisted(() => vi.fn())
const startNewChatMock = vi.hoisted(() => vi.fn())
const desktopWorkbenchMainPropsMock = vi.hoisted(() => vi.fn())
const workbenchMock = vi.hoisted(() => ({
  state: {
    currentRuntimeTask: null as { deviceId: string; taskId: string } | null,
    currentProject: null as { id: number; name: string } | null,
    standaloneDeviceId: null as string | null,
    standaloneChatKey: 1,
    runtimeWork: null,
    projects: [] as Array<{ id: number; name: string }>,
    devices: [
      {
        device_id: 'local-device',
        device_type: 'app',
        status: 'online',
        executor_version: '1.8.5',
      },
    ],
    isBootstrapping: false,
  },
  selectProject: selectProjectMock,
  selectStandaloneDevice: selectStandaloneDeviceMock,
  setWorkbenchError: setWorkbenchErrorMock,
  startNewChat: startNewChatMock,
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging: startDraggingMock }),
}))

vi.mock('@/components/layout/DesktopWorkbenchMain', () => ({
  DesktopWorkbenchMain: (props: Record<string, unknown>) => {
    desktopWorkbenchMainPropsMock(props)
    return <div data-testid="mock-popout-workbench-main" />
  },
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => workbenchMock,
}))

vi.mock('@/features/workbench/workbenchRuntimeHelpers', () => ({
  findRuntimeTask: (_runtimeWork: unknown, address: { taskId: string } | null) =>
    address ? { title: 'Popout task' } : null,
  truncateRuntimeTaskTitle: (title?: string) => title ?? null,
}))

vi.mock('@/tauri/popoutWindow', () => ({
  dismissPopoutWindow: dismissPopoutWindowMock,
  openPopoutTaskInMain: openPopoutTaskInMainMock,
  setPopoutWindowExpanded: setPopoutWindowExpandedMock,
  setPopoutWindowOverlayActive: setPopoutWindowOverlayActiveMock,
}))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('PopoutWorkbenchPage', () => {
  beforeEach(() => {
    dismissPopoutWindowMock.mockReset()
    startDraggingMock.mockReset()
    setPopoutWindowExpandedMock.mockReset()
    setPopoutWindowOverlayActiveMock.mockReset()
    openPopoutTaskInMainMock.mockReset()
    selectProjectMock.mockReset()
    selectStandaloneDeviceMock.mockReset()
    setWorkbenchErrorMock.mockReset()
    startNewChatMock.mockReset()
    desktopWorkbenchMainPropsMock.mockReset()
    workbenchMock.state.currentRuntimeTask = null
    workbenchMock.state.currentProject = null
    workbenchMock.state.standaloneDeviceId = null
    workbenchMock.state.devices = [
      {
        device_id: 'local-device',
        device_type: 'app',
        status: 'online',
        executor_version: '1.8.5',
      },
    ]
    workbenchMock.state.projects = []
    workbenchMock.state.isBootstrapping = false
    localStorage.clear()
    setPopoutWindowExpandedMock.mockResolvedValue(undefined)
    setPopoutWindowOverlayActiveMock.mockResolvedValue(undefined)
    openPopoutTaskInMainMock.mockResolvedValue(undefined)
    dismissPopoutWindowMock.mockResolvedValue(undefined)
  })

  test('starts collapsed and defaults to the local projectless device', async () => {
    render(<PopoutWorkbenchPage />)

    expect(screen.getByTestId('popout-workbench-page')).toHaveClass('popout-window-collapsed')
    expect(screen.getByTestId('popout-workbench-page')).toHaveClass('popout-window-compact-context')
    expect(screen.queryByTestId('popout-window-header')).not.toBeInTheDocument()
    await waitFor(() => expect(setPopoutWindowExpandedMock).toHaveBeenCalledWith(false))
    await waitFor(() => expect(selectStandaloneDeviceMock).toHaveBeenCalledWith('local-device'))
    await waitFor(() => expect(localStorage.getItem('wework.popout.lastProjectId.v1')).toBe('none'))
    expect(desktopWorkbenchMainPropsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        showComposerProjectMenuAction: true,
      })
    )
  })

  test('restores the project previously selected in the Popout Window', async () => {
    localStorage.setItem('wework.popout.lastProjectId.v1', '7')
    workbenchMock.state.projects = [{ id: 7, name: 'Wegent' }]

    render(<PopoutWorkbenchPage />)

    await waitFor(() => expect(selectProjectMock).toHaveBeenCalledWith(7))
    expect(selectStandaloneDeviceMock).not.toHaveBeenCalled()
  })

  test('remembers a project selected by the user', async () => {
    const view = render(<PopoutWorkbenchPage />)
    await waitFor(() => expect(selectStandaloneDeviceMock).toHaveBeenCalledWith('local-device'))

    workbenchMock.state.currentProject = { id: 9, name: 'Wegent' }
    view.rerender(<PopoutWorkbenchPage />)

    await waitFor(() => expect(localStorage.getItem('wework.popout.lastProjectId.v1')).toBe('9'))
  })

  test('never falls back to a cloud device for projectless Popout Window tasks', async () => {
    workbenchMock.state.devices = [
      {
        device_id: 'cloud-device',
        device_type: 'cloud',
        status: 'online',
        executor_version: '1.8.5',
      },
    ]

    render(<PopoutWorkbenchPage />)

    await waitFor(() =>
      expect(setWorkbenchErrorMock).toHaveBeenCalledWith(
        'workbench.popout_window_local_device_required'
      )
    )
    expect(selectStandaloneDeviceMock).not.toHaveBeenCalled()
  })

  test('clears an inherited project context by selecting the local standalone device', async () => {
    workbenchMock.state.currentProject = { id: 1, name: 'Wegent' }

    render(<PopoutWorkbenchPage />)

    expect(screen.getByTestId('popout-workbench-page')).toHaveClass('popout-window-compact-context')
    await waitFor(() => expect(setPopoutWindowExpandedMock).toHaveBeenCalledWith(false))
    await waitFor(() => expect(selectStandaloneDeviceMock).toHaveBeenCalledWith('local-device'))
  })

  test('expands for an active task and closes through the native window', async () => {
    workbenchMock.state.currentRuntimeTask = {
      deviceId: 'local-device',
      taskId: 'task-1',
    }

    render(<PopoutWorkbenchPage />)

    expect(await screen.findByText('Popout task')).toBeInTheDocument()
    await waitFor(() => expect(setPopoutWindowExpandedMock).toHaveBeenCalledWith(true))
    await userEvent.click(screen.getByTestId('popout-window-new-chat-button'))
    expect(startNewChatMock).toHaveBeenCalledOnce()

    await userEvent.click(screen.getByTestId('popout-window-open-in-main-button'))
    expect(openPopoutTaskInMainMock).toHaveBeenCalledWith({
      deviceId: 'local-device',
      taskId: 'task-1',
    })

    await userEvent.click(screen.getByTestId('popout-window-close-button'))
    expect(dismissPopoutWindowMock).toHaveBeenCalledOnce()
  })

  test('closes the native Popout Window with Escape', () => {
    render(<PopoutWorkbenchPage />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(dismissPopoutWindowMock).toHaveBeenCalledOnce()
  })

  test('drags only from visible non-interactive surface space', () => {
    render(<PopoutWorkbenchPage />)

    fireEvent.pointerDown(screen.getByTestId('mock-popout-workbench-main'), { button: 0 })
    expect(startDraggingMock).toHaveBeenCalledOnce()

    fireEvent.pointerDown(screen.getByTestId('popout-workbench-page'), {
      button: 0,
      target: screen.getByTestId('popout-workbench-page'),
    })
    expect(startDraggingMock).toHaveBeenCalledOnce()
  })

  test('temporarily enables mouse events across the native canvas while a menu is open', async () => {
    render(<PopoutWorkbenchPage />)
    const menu = document.createElement('div')
    menu.dataset.testid = 'quick-phrase-menu'

    document.body.append(menu)
    await waitFor(() => expect(setPopoutWindowOverlayActiveMock).toHaveBeenCalledWith(true))

    menu.remove()
    await waitFor(() => expect(setPopoutWindowOverlayActiveMock).toHaveBeenCalledWith(false))
  })
})
