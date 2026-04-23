// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { InboxPage } from '@/features/inbox/components/InboxPage'

type MockDevice = {
  device_id: string
  status: string
  is_default: boolean
  slot_used: number
  slot_max: number
}

type MockMessage = {
  id: number
  status: string
  priority: string
  createdAt: string
  contentSnapshot: Array<{ role: string; content: string }>
  sender: { userName: string; email: string }
  processTaskId: number
}

type InboxProcessMode = 'chat' | 'device' | 'code'

type MessageDetailDialogProps = {
  message: MockMessage | null
  open: boolean
  onProcess: (message: MockMessage, mode: InboxProcessMode) => void
}

const push = jest.fn()
const mockUseDevices = jest.fn()
const mockToastError = jest.fn()
const mockToastSuccess = jest.fn()
const mockGetPreferredExecutionDevice = jest.fn((devices: MockDevice[]) => devices[0] ?? null)

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}))

jest.mock('@/features/inbox/contexts/inboxContext', () => ({
  useInboxContext: () => ({
    refreshQueues: jest.fn(),
    refreshMessages: jest.fn(),
    refreshUnreadCount: jest.fn(),
  }),
}))

jest.mock('@/contexts/DeviceContext', () => ({
  useDevices: () => mockUseDevices(),
}))

jest.mock('@/features/devices/utils/execution-target', () => ({
  getPreferredExecutionDevice: (...args: [MockDevice[]]) =>
    mockGetPreferredExecutionDevice(...args),
}))

jest.mock('@/features/inbox/components/QueueSidebar', () => ({
  QueueSidebar: () => <div data-testid="queue-sidebar" />,
}))

jest.mock('@/features/inbox/components/QueueEditDialog', () => ({
  QueueEditDialog: () => null,
}))

jest.mock('@/features/inbox/components/MessageList', () => ({
  MessageList: ({ onViewMessage }: { onViewMessage: (message: MockMessage) => void }) => (
    <button
      type="button"
      data-testid="open-message-detail"
      onClick={() =>
        onViewMessage({
          id: 42,
          status: 'read',
          priority: 'normal',
          createdAt: '2026-04-23T10:00:00Z',
          contentSnapshot: [{ role: 'USER', content: 'Investigate the issue' }],
          sender: { userName: 'alice', email: 'alice@example.com' },
          processTaskId: 0,
        })
      }
    >
      open
    </button>
  ),
}))

jest.mock('@/features/inbox/components/MessageDetailDialog', () => ({
  MessageDetailDialog: ({ message, open, onProcess }: MessageDetailDialogProps) =>
    open && message ? (
      <div>
        <button type="button" data-testid="send-chat" onClick={() => onProcess(message, 'chat')} />
        <button
          type="button"
          data-testid="send-device"
          onClick={() => onProcess(message, 'device')}
        />
        <button type="button" data-testid="send-code" onClick={() => onProcess(message, 'code')} />
      </div>
    ) : null,
}))

describe('InboxPage process routing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('routes explicit chat mode to the chat page', async () => {
    mockUseDevices.mockReturnValue({ devices: [] })

    const user = userEvent.setup()
    render(<InboxPage />)

    await user.click(screen.getByTestId('open-message-detail'))
    await user.click(screen.getByTestId('send-chat'))

    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenNthCalledWith(1, '/chat?process_message=42')
  })

  it('routes device mode to chat with the preferred device id', async () => {
    const devices = [
      { device_id: 'device-1', status: 'online', is_default: true, slot_used: 0, slot_max: 0 },
    ]
    mockUseDevices.mockReturnValue({ devices })

    const user = userEvent.setup()
    render(<InboxPage />)

    await user.click(screen.getByTestId('open-message-detail'))
    await user.click(screen.getByTestId('send-device'))

    expect(mockGetPreferredExecutionDevice).toHaveBeenCalledTimes(1)
    expect(mockGetPreferredExecutionDevice).toHaveBeenCalledWith(devices)
    expect(mockToastError).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenNthCalledWith(1, '/chat?process_message=42&deviceId=device-1')
  })

  it('falls back to chat mode when no preferred device exists', async () => {
    mockUseDevices.mockReturnValue({ devices: [] })

    const user = userEvent.setup()
    render(<InboxPage />)

    await user.click(screen.getByTestId('open-message-detail'))
    await user.click(screen.getByTestId('send-device'))

    expect(mockGetPreferredExecutionDevice).toHaveBeenCalledTimes(1)
    expect(mockGetPreferredExecutionDevice).toHaveBeenCalledWith([])
    expect(mockToastError).toHaveBeenCalledTimes(1)
    expect(mockToastError).toHaveBeenCalledWith('messages.device_fallback_to_chat')
    await waitFor(() => {
      expect(push).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenNthCalledWith(1, '/chat?process_message=42')
    })
  })

  it('routes code mode to the code page', async () => {
    mockUseDevices.mockReturnValue({ devices: [] })

    const user = userEvent.setup()
    render(<InboxPage />)

    await user.click(screen.getByTestId('open-message-detail'))
    await user.click(screen.getByTestId('send-code'))

    expect(mockGetPreferredExecutionDevice).not.toHaveBeenCalled()
    expect(mockToastError).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenNthCalledWith(1, '/code?process_message=42')
  })
})
