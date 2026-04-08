// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { ForceDeleteTaskSummary } from '@/features/settings/components/ForceDeleteTaskSummary'

describe('ForceDeleteTaskSummary', () => {
  it('renders running task details without nesting lists inside paragraphs', () => {
    render(
      <ForceDeleteTaskSummary
        runningTasks={[
          {
            task_id: 1419,
            task_name: 'task-1419',
            task_title: 'Write a post',
            status: 'RUNNING',
          },
        ]}
        runningTasksTitle="Running tasks"
        warning="Force delete may leave tasks orphaned."
      />
    )

    expect(screen.getByText('Running tasks')).toBeInTheDocument()
    expect(screen.getByText(/Write a post/)).toBeInTheDocument()
    expect(screen.getByText('Force delete may leave tasks orphaned.')).toBeInTheDocument()
    expect(document.body.querySelector('p p')).toBeNull()
    expect(document.body.querySelector('p ul')).toBeNull()
  })
})
