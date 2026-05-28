// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import TaskListSection from '@/features/tasks/components/sidebar/TaskListSection'
import type { Task } from '@/types/api'

const createTask = (id: number, overrides: Partial<Task> = {}): Task => ({
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
  ...overrides,
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

jest.mock('@/features/settings/components/teams/TeamIconDisplay', () => ({
  TeamIconDisplay: ({ iconId }: { iconId?: string | null }) => (
    <span data-testid="task-team-icon">{iconId}</span>
  ),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('TaskListSection', () => {
  it('uses the task team icon when available', () => {
    const task = createTask(1, { team_icon: 'sparkles' })

    render(<TaskListSection tasks={[task]} title="History" />)

    expect(screen.getByTestId('task-team-icon')).toHaveTextContent('sparkles')
  })

  it('shows team information in the task hover tooltip', () => {
    const task = createTask(1, {
      team_name: 'code-agent',
      team_display_name: 'Code Agent',
    })

    render(<TaskListSection tasks={[task]} title="History" />)

    expect(screen.getByText('Code Agent')).toBeInTheDocument()
  })

  it('falls back to team id when task source names are missing', () => {
    const task = createTask(1, { team_id: 42 })

    render(<TaskListSection tasks={[task]} title="History" />)

    expect(screen.getByText('common:teamSelector.agent_label #42')).toBeInTheDocument()
  })

  it('limits visible tasks and expands remaining tasks from the more action', () => {
    const tasks = Array.from({ length: 6 }, (_, index) => createTask(index + 1))

    render(<TaskListSection tasks={tasks} title="Wegent Chat" initialVisibleCount={5} />)

    expect(screen.getAllByText('Conversation 1')[0]).toBeInTheDocument()
    expect(screen.getAllByText('Conversation 5')[0]).toBeInTheDocument()
    expect(screen.queryAllByText('Conversation 6')).toHaveLength(0)

    const moreButton = screen.getByTestId('task-list-section-show-more')
    expect(moreButton).toHaveTextContent('common:tasks.show_more')
    expect(moreButton).toHaveClass('h-11', 'min-w-[44px]')

    fireEvent.click(moreButton)

    expect(screen.getAllByText('Conversation 6')[0]).toBeInTheDocument()
    expect(moreButton).toHaveTextContent('common:tasks.show_less')

    fireEvent.click(moreButton)

    expect(screen.queryAllByText('Conversation 6')).toHaveLength(0)
    expect(moreButton).toHaveTextContent('common:tasks.show_more')
  })
})
