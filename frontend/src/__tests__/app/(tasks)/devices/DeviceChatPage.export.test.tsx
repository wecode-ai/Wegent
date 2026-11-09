// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { DeviceInfo } from '@/apis/devices'

import DeviceChatPage from '@/app/(tasks)/devices/chat/page'

const devices: DeviceInfo[] = [
  {
    id: 1,
    device_id: 'executor-device',
    name: 'Executor Device',
    status: 'online',
    is_default: true,
    device_type: 'local',
    connection_mode: 'websocket',
    slot_used: 0,
    slot_max: 1,
    running_tasks: [],
    executor_version: '1.8.8',
    latest_version: '1.8.8',
    update_available: false,
    bind_shell: 'claudecode',
  },
]

/** Controls what ChatArea reports back through onShareButtonRender. */
let renderShareButton = true
let isMobile = false
let searchParams = new URLSearchParams()
const replace = jest.fn()
const push = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push }),
  useSearchParams: () => searchParams,
}))

jest.mock('@/features/tasks/components/chat/ChatArea', () => {
  const React = jest.requireActual('react')

  function MockChatArea({
    onShareButtonRender,
  }: {
    onShareButtonRender?: (button: ReactNode) => void
  }) {
    React.useEffect(() => {
      if (renderShareButton) {
        onShareButtonRender?.(
          <button type="button" data-testid="stub-conversation-export">
            Export
          </button>
        )
      }
    }, [onShareButtonRender])
    return <div data-testid="device-chat-area" />
  }

  return { __esModule: true, default: MockChatArea }
})

jest.mock('@/features/layout/TaskTitleDropdown', () => ({
  __esModule: true,
  default: ({ title }: { title?: string }) => <span>{title}</span>,
}))

jest.mock('@/features/tasks/components/sidebar', () => ({
  TaskSidebar: ({
    isMobileSidebarOpen,
    setIsMobileSidebarOpen,
  }: {
    isMobileSidebarOpen: boolean
    setIsMobileSidebarOpen: (open: boolean) => void
  }) =>
    isMobileSidebarOpen && (
      <div role="dialog" aria-label="Task list">
        <button type="button" onClick={() => setIsMobileSidebarOpen(false)}>
          Close task list
        </button>
      </div>
    ),
  ResizableSidebar: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CollapsedSidebarButtons: () => null,
}))

jest.mock('@/features/tasks/components/params', () => ({
  TaskParamSync: () => null,
  DeviceParamSync: () => null,
}))

jest.mock('@/features/layout/GithubStarButton', () => ({ GithubStarButton: () => null }))
jest.mock('@/features/theme/ThemeToggle', () => ({ ThemeToggle: () => null }))
jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => isMobile,
  useIsDesktop: () => !isMobile,
}))
jest.mock('@/features/devices/utils/device-status', () => ({ isOpenClawDevice: () => false }))
jest.mock('@/features/devices/hooks/useAdvancedDeviceMode', () => ({
  useAdvancedDeviceMode: () => ({ showAdvancedDevices: true, isAdvancedDeviceModeReady: true }),
}))
jest.mock('@/features/projects/contexts/projectContext', () => ({
  useProjectContext: () => ({ projects: [] }),
}))
jest.mock('@/features/common/UserContext', () => ({ useUser: () => ({ user: null }) }))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({
    selectTask: jest.fn(),
    selectedTaskDetail: {
      id: 42,
      title: 'Device conversation',
      task_type: 'task',
      device_id: 'executor-device',
    },
    refreshTasks: jest.fn(),
    refreshSelectedTaskDetail: jest.fn(),
  }),
}))
jest.mock('@/contexts/DeviceContext', () => ({
  useDevices: () => ({
    devices,
    selectedDeviceId: 'executor-device',
    setSelectedDeviceId: jest.fn(),
  }),
}))
jest.mock('@/contexts/TeamContext', () => ({
  useTeamContext: () => ({
    teams: [],
    isTeamsLoading: false,
    loadError: null,
    refreshTeams: jest.fn(),
  }),
}))

describe('DeviceChatPage navigation', () => {
  beforeEach(() => {
    localStorage.clear()
    renderShareButton = true
    isMobile = false
    searchParams = new URLSearchParams()
    jest.clearAllMocks()
  })

  it('renders the share and export actions reported by ChatArea in the top navigation', async () => {
    render(<DeviceChatPage />)

    await waitFor(() => {
      expect(screen.getByTestId('stub-conversation-export')).toBeInTheDocument()
    })
    expect(screen.getByRole('banner')).toContainElement(
      screen.getByTestId('stub-conversation-export')
    )
  })

  it('keeps the top navigation free of export actions when ChatArea reports none', async () => {
    renderShareButton = false

    render(<DeviceChatPage />)

    await waitFor(() => {
      expect(screen.getByTestId('device-chat-area')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('stub-conversation-export')).not.toBeInTheDocument()
  })

  it('opens the task list from a mobile device task link without navigating away', async () => {
    isMobile = true
    searchParams.set('taskId', '42')
    render(<DeviceChatPage />)

    const chat = await screen.findByTestId('device-chat-area')
    const selector = screen.getByRole('combobox', { name: 'select_device' })
    const sidebarToggle = screen.getByRole('button', { name: 'common:common.open_sidebar' })
    expect(sidebarToggle.parentElement).toContainElement(selector)
    expect(selector).toBeDisabled()
    expect(selector).toHaveValue('executor-device')

    fireEvent.click(sidebarToggle)
    expect(screen.getByRole('dialog', { name: 'Task list' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close task list' }))
    expect(screen.queryByRole('dialog', { name: 'Task list' })).not.toBeInTheDocument()
    expect(screen.getByTestId('device-chat-area')).toBe(chat)
    expect(replace).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })
})
