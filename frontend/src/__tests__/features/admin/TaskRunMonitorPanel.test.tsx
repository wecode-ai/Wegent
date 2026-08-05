// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { adminApis } from '@/apis/admin'
import { TaskRunMonitorPanel } from '@/features/admin/components/TaskRunMonitorPanel'

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getTaskRunStats: jest.fn(),
  },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('sonner', () => ({
  toast: { error: jest.fn() },
}))

jest.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children, ...props }: React.HTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: () => <span />,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const getTaskRunStats = adminApis.getTaskRunStats as jest.MockedFunction<
  typeof adminApis.getTaskRunStats
>

describe('TaskRunMonitorPanel', () => {
  beforeEach(() => {
    getTaskRunStats.mockResolvedValue({
      hours: 24,
      window_start: '2026-08-04T00:00:00',
      window_end: '2026-08-05T00:00:00',
      total_runs: 3,
      by_status: {
        PENDING: 0,
        RUNNING: 0,
        COMPLETED: 2,
        FAILED: 1,
        CANCELLED: 0,
      },
      success_rate: 66.7,
      failure_rate: 33.3,
      failure_reasons: [
        {
          reason: 'Executor timed out',
          count: 1,
          percentage: 100,
          latest_at: '2026-08-04T23:00:00',
        },
      ],
      recent_failures: [
        {
          subtask_id: 42,
          task_id: 7,
          task_title: 'Investigate executor',
          user_id: 3,
          user_name: 'tester',
          client_origin: 'frontend',
          error_message: 'Executor timed out',
          created_at: '2026-08-04T22:59:00',
          updated_at: '2026-08-04T23:00:00',
        },
      ],
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('loads and displays run status and failure details', async () => {
    render(<TaskRunMonitorPanel />)

    await waitFor(() => expect(getTaskRunStats).toHaveBeenCalledWith(24))

    expect(await screen.findByText('Investigate executor')).toBeInTheDocument()
    expect(screen.getAllByText('Executor timed out')).toHaveLength(2)
    expect(screen.getByText('COMPLETED 2')).toBeInTheDocument()
    expect(screen.getByText('FAILED 1')).toBeInTheDocument()
  })
})
