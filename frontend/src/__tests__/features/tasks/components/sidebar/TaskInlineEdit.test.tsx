// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import TaskInlineEdit from '@/features/tasks/components/sidebar/TaskInlineEdit'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/apis/tasks', () => ({
  taskApis: {
    updateTask: jest.fn(),
  },
}))

describe('TaskInlineEdit', () => {
  it('uses theme-aware text color for the edit input', () => {
    render(
      <TaskInlineEdit
        taskId={1}
        initialTitle="Conversation 1"
        onSave={jest.fn()}
        onCancel={jest.fn()}
      />
    )

    const input = screen.getByDisplayValue('Conversation 1')

    expect(input).toHaveClass('text-text-primary')
    expect(input).not.toHaveClass('text-[#444746]')
  })
})
