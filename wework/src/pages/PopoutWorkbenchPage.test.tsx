import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { PopoutWorkbenchPage } from './PopoutWorkbenchPage'

const dismissPopoutWindowMock = vi.hoisted(() => vi.fn())
const setPopoutWindowModeMock = vi.hoisted(() => vi.fn())
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
        device_type: 'local',
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

vi.mock('@/desktop/popoutWindow', () => ({
  dismissPopoutWindow: dismissPopoutWindowMock,
  openPopoutTaskInMain: openPopoutTaskInMainMock,
  setPopoutWindowMode: setPopoutWindowModeMock,
}))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('PopoutWorkbenchPage', () => {
  beforeEach(() => {
    dismissPopoutWindowMock.mockReset()
    setPopoutWindowModeMock.mockReset()
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
        device_type: 'local',
        status: 'online',
        executor_version: '1.8.5',
      },
    ]
    workbenchMock.state.projects = []
    workbenchMock.state.isBootstrapping = false
    localStorage.clear()
    setPopoutWindowModeMock.mockResolvedValue(undefined)
    openPopoutTaskInMainMock.mockResolvedValue(undefined)
    dismissPopoutWindowMock.mockResolvedValue(undefined)
  })

  test('starts collapsed and defaults to the local projectless device', async () => {
    render(<PopoutWorkbenchPage />)

    expect(screen.getByTestId('popout-workbench-page')).toHaveClass('popout-window-compact')
    expect(screen.getByTestId('popout-workbench-page')).toHaveAttribute(
      'data-popout-mode',
      'composer'
    )
    expect(screen.queryByTestId('popout-window-header')).not.toBeInTheDocument()
    await waitFor(() => expect(setPopoutWindowModeMock).toHaveBeenCalledWith('composer'))
    await waitFor(() => expect(selectStandaloneDeviceMock).toHaveBeenCalledWith('local-device'))
    await waitFor(() => expect(localStorage.getItem('wework.popout.lastProjectId.v1')).toBe('none'))
    expect(desktopWorkbenchMainPropsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        presentation: 'popout',
      })
    )
  })

  test('selects the local IPC device when another computer is listed first', async () => {
    workbenchMock.state.devices.unshift({
      device_id: 'another-computer',
      device_type: 'app',
      status: 'online',
      executor_version: '1.8.5',
    })

    render(<PopoutWorkbenchPage />)

    await waitFor(() => expect(selectStandaloneDeviceMock).toHaveBeenCalledWith('local-device'))
    expect(selectStandaloneDeviceMock).toHaveBeenCalledTimes(1)
    expect(setWorkbenchErrorMock).not.toHaveBeenCalled()
  })

  test('requires the local IPC device even when another computer is online', async () => {
    workbenchMock.state.devices = [
      {
        device_id: 'another-computer',
        device_type: 'app',
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
})
