// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import { QueueSidebar } from '@/features/inbox/components/QueueSidebar'

const mockSetSelectedQueueId = jest.fn()
const mockRefreshQueues = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

jest.mock('@/features/inbox/contexts/inboxContext', () => ({
  useInboxContext: () => ({
    queues: [
      {
        id: 1,
        name: 'support',
        displayName: 'Support',
        description: 'Support inbox',
        isDefault: false,
        visibility: 'private',
        messageCount: 3,
        unreadCount: 2,
        createdAt: '2026-04-22T08:00:00.000Z',
        updatedAt: '2026-04-22T08:00:00.000Z',
      },
    ],
    queuesLoading: false,
    selectedQueueId: 999,
    setSelectedQueueId: mockSetSelectedQueueId,
    unreadCount: {
      total: 2,
      byQueue: {
        1: 2,
      },
    },
    refreshQueues: mockRefreshQueues,
  }),
}))

jest.mock('@/features/templates', () => ({
  TemplateSelectDialog: () => null,
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/dropdown', () => {
  const React = jest.requireActual('react') as typeof import('react')
  type MockDropdownTriggerChildProps = {
    onClick?: React.MouseEventHandler
  }

  const DropdownContext = React.createContext<{
    open: boolean
    setOpen: (open: boolean) => void
  } | null>(null)

  const DropdownMenu = ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode
    onOpenChange?: (open: boolean) => void
  }) => {
    const [open, setOpenState] = React.useState(false)

    const setOpen = (value: boolean) => {
      setOpenState(value)
      onOpenChange?.(value)
    }

    return <DropdownContext.Provider value={{ open, setOpen }}>{children}</DropdownContext.Provider>
  }

  const DropdownMenuTrigger = ({
    children,
    asChild,
    onClick,
  }: {
    children: React.ReactNode
    asChild?: boolean
    onClick?: React.MouseEventHandler
  }) => {
    const context = React.useContext(DropdownContext)

    if (asChild && React.isValidElement<MockDropdownTriggerChildProps>(children)) {
      return React.cloneElement(children, {
        onClick: event => {
          onClick?.(event)
          children.props.onClick?.(event)
          if (!event.isPropagationStopped()) {
            context?.setOpen(!context.open)
          } else {
            context?.setOpen(true)
          }
        },
      })
    }

    return (
      <button
        onClick={event => {
          onClick?.(event)
          context?.setOpen(!context?.open)
        }}
      >
        {children}
      </button>
    )
  }

  const DropdownMenuContent = ({ children }: { children: React.ReactNode }) => {
    const context = React.useContext(DropdownContext)
    return context?.open ? <div>{children}</div> : null
  }

  const DropdownMenuItem = ({
    children,
    onClick,
    className,
  }: {
    children: React.ReactNode
    onClick?: () => void
    className?: string
  }) => (
    <button className={className} onClick={onClick} type="button">
      {children}
    </button>
  )

  const DropdownMenuSeparator = () => <div />

  return {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
  }
})

describe('QueueSidebar', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows the queue menu on hover without reserving space by default and keeps it visible once open', () => {
    render(
      <QueueSidebar
        onCreateQueue={jest.fn()}
        onDeleteQueue={jest.fn()}
        onEditQueue={jest.fn()}
        onSetDefault={jest.fn()}
      />
    )

    const queueItem = screen.getByTestId('queue-item-1')

    expect(queueItem).toHaveClass('pr-3')
    expect(queueItem).not.toHaveClass('pr-11')

    fireEvent.mouseEnter(queueItem)

    expect(queueItem).toHaveClass('pr-11')

    const menuTrigger = screen.getByTestId('queue-menu-trigger-1')
    const menuVisibilityContainer = menuTrigger.parentElement

    expect(menuVisibilityContainer).toHaveClass('opacity-100')

    fireEvent.click(menuTrigger)
    fireEvent.mouseLeave(queueItem)

    expect(mockSetSelectedQueueId).not.toHaveBeenCalled()
    expect(queueItem).toHaveClass('pr-11')
    expect(menuVisibilityContainer).toHaveClass('opacity-100')
    expect(screen.getByText('queues.edit')).toBeInTheDocument()
  })
})
