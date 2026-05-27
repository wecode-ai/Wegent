// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import TaskListSection from '@/features/tasks/components/sidebar/TaskListSection'
import type { Task } from '@/types/api'

const createTask = (id: number): Task => ({
  id,
  title: `Conversation ${id}`,
  team_id: 1,
  git_url: '',
  git_repo: '',
  git_repo_id: 0,
  git_domain: '',
  branch_name: '',
  prompt: '',
  status: 'COMPLETED',
  progress: 100,
  batch: 0,
  result: {},
  error_message: '',
  user_id: 1,
  user_name: 'user',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:00.000Z',
})

const mockPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

jest.mock('@/features/tasks/contexts/taskContext', () => ({
  useTaskContext: () => ({
    selectedTask: null,
    selectedTaskDetail: null,
    setSelectedTask: jest.fn(),
    refreshTasks: jest.fn(),
    viewStatusVersion: 0,
    markTaskAsViewed: jest.fn(),
  }),
}))

jest.mock('@/features/tasks/contexts/chatStreamContext', () => ({
  useChatStreamContext: () => ({
    clearAllStreams: jest.fn(),
  }),
}))

jest.mock('@/features/projects', () => ({
  useProjectContext: () => ({
    setSelectedProjectTaskId: jest.fn(),
  }),
}))

jest.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: jest.fn(),
    isDragging: false,
  }),
}))

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@/features/tasks/components/sidebar/TaskMenu', () => ({
  __esModule: true,
  default: () => <div data-testid="task-menu" />,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('TaskListSection', () => {
  it('limits visible tasks and expands remaining tasks from the more action', () => {
    const tasks = Array.from({ length: 6 }, (_, index) => createTask(index + 1))

    render(<TaskListSection tasks={tasks} title="Wegent Chat" initialVisibleCount={5} />)

    expect(screen.getAllByText('Conversation 1')[0]).toBeInTheDocument()
    expect(screen.getAllByText('Conversation 5')[0]).toBeInTheDocument()
    expect(screen.queryAllByText('Conversation 6')).toHaveLength(0)

    const moreButton = screen.getByTestId('task-list-section-show-more')
    expect(moreButton).toHaveTextContent('common:tasks.show_more')

    fireEvent.click(moreButton)

    expect(screen.getAllByText('Conversation 6')[0]).toBeInTheDocument()
    expect(moreButton).toHaveTextContent('common:tasks.show_less')

    fireEvent.click(moreButton)

    expect(screen.queryAllByText('Conversation 6')).toHaveLength(0)
    expect(moreButton).toHaveTextContent('common:tasks.show_more')
  })
})
