// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { QueueMessage } from '@/apis/work-queue'
import { MessageDetailDialog } from '@/features/inbox/components/MessageDetailDialog'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    variant,
    ...props
  }: {
    children: React.ReactNode
    variant?: string
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button data-variant={variant} {...props}>
      {children}
    </button>
  ),
}))

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const message = {
  id: 101,
  status: 'unread',
  priority: 'normal',
  createdAt: '2026-04-23T10:00:00Z',
  note: 'Need follow-up',
  contentSnapshot: [{ role: 'USER', content: 'Please investigate this issue' }],
  sender: { userName: 'alice', email: 'alice@example.com' },
  processTaskId: 0,
} as QueueMessage

describe('MessageDetailDialog', () => {
  it('renders three process shortcut buttons and forwards each selected mode', async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    const onProcess = jest.fn()

    render(
      <MessageDetailDialog
        message={message}
        open
        onOpenChange={onOpenChange}
        onProcess={onProcess}
      />
    )

    expect(screen.getByTestId('send-to-chat-button')).toBeInTheDocument()
    expect(screen.getByTestId('send-to-device-button')).toBeInTheDocument()
    expect(screen.getByTestId('send-to-code-button')).toBeInTheDocument()
    expect(screen.getByTestId('send-to-chat-button')).toHaveAttribute('data-variant', 'primary')
    expect(screen.getByTestId('send-to-device-button')).toHaveAttribute('data-variant', 'outline')
    expect(screen.getByTestId('send-to-code-button')).toHaveAttribute('data-variant', 'outline')

    await user.click(screen.getByTestId('send-to-chat-button'))
    expect(onProcess).toHaveBeenNthCalledWith(1, message, 'chat')
    expect(onOpenChange).toHaveBeenNthCalledWith(1, false)

    await user.click(screen.getByTestId('send-to-device-button'))
    expect(onProcess).toHaveBeenNthCalledWith(2, message, 'device')
    expect(onOpenChange).toHaveBeenNthCalledWith(2, false)

    await user.click(screen.getByTestId('send-to-code-button'))
    expect(onProcess).toHaveBeenNthCalledWith(3, message, 'code')
    expect(onOpenChange).toHaveBeenNthCalledWith(3, false)
  })
})
