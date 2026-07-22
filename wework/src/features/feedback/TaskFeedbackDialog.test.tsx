import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })
  })

  test('presents runtime logs as one user-facing option', () => {
    render(
      <TaskFeedbackDialog
        open
        getTaskContext={async () => ({ taskId: 'task-1' })}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('运行日志')).toBeInTheDocument()
    expect(screen.queryByText('Executor 日志')).not.toBeInTheDocument()
    expect(screen.queryByText('Tauri 日志')).not.toBeInTheDocument()
    expect(screen.getByTestId('task-feedback-runtimeLogs-checkbox')).toBeChecked()
  })

  test('disables export when every information category is unchecked', () => {
    render(
      <TaskFeedbackDialog
        open
        getTaskContext={async () => ({ taskId: 'task-1' })}
        onClose={vi.fn()}
      />
    )
    ;['runtimeLogs', 'taskInfo', 'screenshot', 'systemInfo'].forEach(key => {
      fireEvent.click(screen.getByTestId(`task-feedback-${key}-checkbox`))
    })

    expect(screen.getByTestId('task-feedback-export-button')).toBeDisabled()
  })

  test('hides the dialog while capturing and exports the complete task context', async () => {
    let resolveCapture: (value: string) => void = () => undefined
    const capture = new Promise<string>(resolve => {
      resolveCapture = resolve
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'capture_main_webview') return capture
      if (command === 'export_feedback_bundle') {
        return Promise.resolve({ reportId: 'WF-1', path: '/tmp/feedback.zip' })
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`))
    })
    const getTaskContext = vi.fn().mockResolvedValue({
      conversation: {
        messages: [
          { id: 'user-1', role: 'user', content: 'question' },
          { id: 'assistant-1', role: 'assistant', content: 'answer' },
        ],
      },
    })
    render(<TaskFeedbackDialog open getTaskContext={getTaskContext} onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('task-feedback-export-button'))

    await waitFor(() => {
      const overlay = screen.getByTestId('task-feedback-dialog-overlay')
      expect(overlay).toHaveClass('invisible')
      expect(overlay).toHaveStyle({ visibility: 'hidden' })
    })
    await act(async () => resolveCapture('data:image/png;base64,aGVsbG8='))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('export_feedback_bundle', expect.anything())
    )
    expect(screen.getByTestId('task-feedback-dialog-overlay')).not.toHaveClass('invisible')
    expect(screen.getByTestId('task-feedback-dialog-overlay')).not.toHaveStyle({
      visibility: 'hidden',
    })
    expect(getTaskContext).toHaveBeenCalledOnce()
    expect(invokeMock).toHaveBeenCalledWith(
      'export_feedback_bundle',
      expect.objectContaining({
        request: expect.objectContaining({
          taskContext: expect.objectContaining({
            conversation: expect.objectContaining({
              messages: expect.arrayContaining([
                expect.objectContaining({ content: 'question' }),
                expect.objectContaining({ content: 'answer' }),
              ]),
            }),
          }),
        }),
      })
    )
  })
})
