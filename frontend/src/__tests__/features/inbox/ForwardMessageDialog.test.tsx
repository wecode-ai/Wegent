// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
  ForwardMessageDialog,
  type ForwardableMessage,
} from '@/features/inbox/components/ForwardMessageDialog'

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: { id: 1 },
  }),
}))

jest.mock('sonner', () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}))

jest.mock('@/apis/work-queue', () => ({
  forwardMessages: jest.fn(),
  getRecentContacts: jest.fn().mockResolvedValue({ items: [] }),
  getUserPublicQueues: jest.fn().mockResolvedValue({ queues: [] }),
  listWorkQueues: jest.fn().mockResolvedValue({ items: [] }),
}))

jest.mock('@/utils/dateTime', () => ({
  formatDateTime: () => '2026-06-05 12:00:00',
}))

jest.mock('@/components/common/UserSearchSelect', () => ({
  UserSearchSelect: () => <div data-testid="user-search-select" />,
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({
    children,
    ...props
  }: {
    children: React.ReactNode
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}))

jest.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    onClick,
  }: {
    checked?: boolean
    onCheckedChange?: () => void
    onClick?: React.MouseEventHandler<HTMLInputElement>
  }) => (
    <input
      type="checkbox"
      checked={checked}
      readOnly
      onChange={onCheckedChange}
      onClick={onClick}
    />
  ),
}))

const messages: ForwardableMessage[] = [
  {
    subtaskId: 1,
    type: 'user',
    content: 'First message',
    timestamp: 1,
  },
  {
    subtaskId: 2,
    type: 'ai',
    content: 'Second message',
    timestamp: 2,
    botName: 'Bot',
  },
  {
    subtaskId: 3,
    type: 'user',
    content: 'Third message',
    timestamp: 3,
  },
]

describe('ForwardMessageDialog', () => {
  it('preserves manual select-all state across parent rerenders with the same initial subtask ids', async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()

    const { rerender } = render(
      <ForwardMessageDialog
        taskId={42}
        subtaskIds={[1]}
        allMessages={messages}
        open
        onOpenChange={onOpenChange}
      />
    )

    await user.click(screen.getByTestId('forward-select-all'))
    expect(screen.getByText('(3/3)')).toBeInTheDocument()

    rerender(
      <ForwardMessageDialog
        taskId={42}
        subtaskIds={[1]}
        allMessages={messages}
        open
        onOpenChange={onOpenChange}
      />
    )

    expect(screen.getByText('(3/3)')).toBeInTheDocument()
  })
})
