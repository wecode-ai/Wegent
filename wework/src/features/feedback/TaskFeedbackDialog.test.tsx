import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { TaskFeedbackDialog } from './TaskFeedbackDialog'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'workbench.feedback_runtime_logs': '运行日志',
      })[key] ?? key,
  }),
}))

describe('TaskFeedbackDialog', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  test('presents runtime logs as one user-facing option', () => {
    render(<TaskFeedbackDialog open taskContext={{ taskId: 'task-1' }} onClose={vi.fn()} />)

    expect(screen.getByText('运行日志')).toBeInTheDocument()
    expect(screen.queryByText('Executor 日志')).not.toBeInTheDocument()
    expect(screen.queryByText('Tauri 日志')).not.toBeInTheDocument()
    expect(screen.getByTestId('task-feedback-runtimeLogs-checkbox')).toBeChecked()
  })

  test('disables export when every information category is unchecked', () => {
    render(<TaskFeedbackDialog open taskContext={{ taskId: 'task-1' }} onClose={vi.fn()} />)
    ;['runtimeLogs', 'taskInfo', 'screenshot', 'systemInfo'].forEach(key => {
      fireEvent.click(screen.getByTestId(`task-feedback-${key}-checkbox`))
    })

    expect(screen.getByTestId('task-feedback-export-button')).toBeDisabled()
  })
})
