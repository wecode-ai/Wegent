// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { taskApis } from '@/apis/tasks'
import HistoryManageDialog from '@/features/tasks/components/sidebar/HistoryManageDialog'
import type { Task } from '@/types/api'

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}))

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({
    refreshPersonalTasks: jest.fn(),
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/apis/tasks', () => ({
  taskApis: {
    getPersonalTasksLite: jest.fn(),
    bulkDeleteTasks: jest.fn(),
    deleteAllPersonalTasks: jest.fn(),
    deleteTask: jest.fn(),
  },
}))

const mockedTaskApis = taskApis as jest.Mocked<typeof taskApis>

const createTask = (id: number): Task => ({
  id,
  title: `Task ${id}`,
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
  created_at: '2026-08-10T08:00:00.000Z',
  updated_at: '2026-08-10T08:00:00.000Z',
  completed_at: '2026-08-10T08:00:00.000Z',
})

describe('HistoryManageDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.localStorage.clear()
    mockedTaskApis.getPersonalTasksLite.mockResolvedValue({
      items: [createTask(1), createTask(2)],
      total: 2,
    })
    mockedTaskApis.bulkDeleteTasks.mockResolvedValue({
      message: 'deleted',
      count: 1,
    })
    mockedTaskApis.deleteAllPersonalTasks.mockResolvedValue({
      message: 'deleted',
      count: 0,
    })
    mockedTaskApis.deleteTask.mockResolvedValue({ message: 'deleted' })
  })

  it('requires confirmation before deleting selected tasks', async () => {
    render(<HistoryManageDialog open={true} onOpenChange={jest.fn()} />)

    const firstCheckbox = await screen.findByTestId('history-task-checkbox-1')
    fireEvent.click(firstCheckbox)
    fireEvent.click(screen.getByTestId('history-delete-selected-button'))

    expect(mockedTaskApis.bulkDeleteTasks).not.toHaveBeenCalled()
    expect(screen.getByText('history:confirm.delete_selected')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('history-confirm-delete-selected-button'))

    await waitFor(() => {
      expect(mockedTaskApis.bulkDeleteTasks).toHaveBeenCalledWith([1])
    })
  })

  it('uses task membership to detect whether all loaded tasks are selected', async () => {
    render(<HistoryManageDialog open={true} onOpenChange={jest.fn()} initialTaskId={999} />)

    const selectAllToggle = await screen.findByTestId('history-select-all-toggle')

    expect(selectAllToggle.querySelector('.lucide-square')).toBeInTheDocument()
    expect(selectAllToggle.querySelector('.lucide-square-check-big')).not.toBeInTheDocument()
  })

  it('provides touch-sized task controls with stable test IDs', async () => {
    render(<HistoryManageDialog open={true} onOpenChange={jest.fn()} />)

    const checkbox = await screen.findByTestId('history-task-checkbox-1')
    const deleteButton = screen.getByTestId('history-task-delete-1')

    expect(checkbox).toHaveClass('h-11', 'w-11', 'min-w-[44px]')
    expect(deleteButton).toHaveClass('h-11', 'w-11', 'min-w-[44px]')
    expect(deleteButton).not.toHaveClass('opacity-0')
  })
})
