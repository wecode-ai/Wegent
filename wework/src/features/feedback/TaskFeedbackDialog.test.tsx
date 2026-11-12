import { resetComposerDiagnosticsForTest } from '@/components/chat/composer/composerDiagnostics'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { resetConversationDiagnosticsForTest } from '@wegent/collaboration/conversation/conversationDiagnostics'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { TaskFeedbackDialog } from './TaskFeedbackDialog'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))
const trackMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: invokeMock }))
vi.mock('@/telemetry/client', () => ({ track: trackMock }))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'workbench.feedback_group_standard': '常规诊断',
        'workbench.feedback_group_user_content': '用户提供内容（含隐私内容）',
        'workbench.feedback_group_full_task': '完整任务数据（含隐私内容）',
        'workbench.feedback_task_info': '任务信息',
        'workbench.feedback_screenshot': '页面截图',
        'workbench.feedback_runtime_logs': '运行日志',
        'workbench.feedback_attachments': '用户附件',
        'workbench.feedback_preview': '预览导出内容',
        'workbench.feedback_confirm_export': '确认导出',
        'workbench.feedback_submit': '提交反馈',
        'workbench.feedback_submitted': '反馈已提交',
        'workbench.feedback_board_item': '反馈单编号',
        'workbench.feedback_default_title': 'Wework 问题反馈',
        'workbench.feedback_contact_developer_with_report': '提交失败：{{reportId}}',
        'workbench.feedback_back': '返回',
        'workbench.feedback_exported': '已导出',
        'workbench.feedback_preview_truncated': '（内容过长，仅显示前一部分）',
      })[key] ?? key,
    i18n: { t: (key: string) => key },
  }),
}))

const previewResult = {
  stagingId: 'staging-1',
  reportId: 'WF-1',
  finalFileName: 'wework-feedback-WF-1.zip',
  skipped: [] as string[],
  warnings: [] as string[],
  entries: [
    {
      category: 'report',
      archivePath: 'report.md',
      sizeBytes: 64,
      previewable: true,
      content: '# Wework feedback',
      truncated: false,
    },
    {
      category: 'task',
      archivePath: 'context/task.json',
      sizeBytes: 128,
      previewable: true,
      content: '{"task":{"id":"task-1"}}',
      truncated: false,
    },
    {
      category: 'screenshot',
      archivePath: 'screenshot.png',
      sizeBytes: 1024,
      previewable: false,
      content: null,
      truncated: false,
    },
  ],
}

describe('TaskFeedbackDialog', () => {
  beforeEach(() => {
    resetComposerDiagnosticsForTest()
    resetConversationDiagnosticsForTest()
    invokeMock.mockReset()
    trackMock.mockReset()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })
  })

  test('builds a preview before writing any exported file', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'e2e.capturePrimaryView')
        return Promise.resolve('data:image/png;base64,aGVsbG8=')
      if (command === 'feedback.previewBundle') return Promise.resolve(previewResult)
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
    render(
      <TaskFeedbackDialog open hasActiveTask getTaskContext={getTaskContext} onClose={vi.fn()} />
    )

    fireEvent.change(screen.getByTestId('task-feedback-note'), {
      target: { value: 'Messages are missing from the task' },
    })
    fireEvent.click(screen.getByTestId('task-feedback-group-full-task-checkbox'))
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))

    await waitFor(() =>
      expect(screen.getByTestId('task-feedback-preview-list')).toBeInTheDocument()
    )
    expect(screen.queryByTestId('task-feedback-submit-button')).not.toBeInTheDocument()
    expect(getTaskContext).toHaveBeenCalledOnce()
    expect(invokeMock).toHaveBeenCalledWith(
      'feedback.previewBundle',
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
    // Nothing has been written to disk yet.
    expect(invokeMock).not.toHaveBeenCalledWith('feedback.confirmBundle', expect.anything())
  })

  test('submits the exact previewed bundle through the configured feedback API', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'feedback.previewBundle') return Promise.resolve(previewResult)
      return Promise.reject(new Error(`Unexpected command: ${command}`))
    })
    const feedbackApi = {
      submit: vi.fn().mockResolvedValue({
        report_id: 'WF-1',
        item_id: 'FEEDBACK-1',
        duplicate: false,
      }),
    }
    render(
      <TaskFeedbackDialog
        open
        hasActiveTask
        feedbackApi={feedbackApi}
        getTaskContext={async () => ({ task: { title: 'Broken task' } })}
        onClose={vi.fn()}
      />
    )

    fireEvent.change(screen.getByTestId('task-feedback-note'), {
      target: { value: 'Cannot send messages' },
    })
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))
    await screen.findByTestId('task-feedback-preview-list')
    fireEvent.click(screen.getByTestId('task-feedback-submit-button'))

    await waitFor(() => expect(feedbackApi.submit).toHaveBeenCalledOnce())
    expect(feedbackApi.submit).toHaveBeenCalledWith({
      stagingId: 'staging-1',
      title: 'Cannot send messages',
      description: 'Cannot send messages',
      context: {},
    })
    expect(await screen.findByText(/FEEDBACK-1/)).toBeInTheDocument()
    expect(invokeMock).not.toHaveBeenCalledWith('feedback.confirmBundle', expect.anything())
  })

  test('logs a safe failure classification with the report ID when submission fails', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'feedback.previewBundle') return Promise.resolve(previewResult)
      return Promise.reject(new Error(`Unexpected command: ${command}`))
    })
    const feedbackApi = {
      submit: vi.fn().mockRejectedValue(new Error('Feedback submission failed with HTTP 413')),
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(
      <TaskFeedbackDialog
        open
        hasActiveTask
        feedbackApi={feedbackApi}
        getTaskContext={async () => ({})}
        onClose={vi.fn()}
      />
    )

    fireEvent.change(screen.getByTestId('task-feedback-note'), {
      target: { value: 'Cannot send messages' },
    })
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))
    await screen.findByTestId('task-feedback-preview-list')
    fireEvent.click(screen.getByTestId('task-feedback-submit-button'))

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[Wework] Feedback submission failed', {
        reportId: 'WF-1',
        errorKind: 'http_413',
      })
    )
    expect(trackMock).toHaveBeenCalledWith('operation_failed', { operation: 'feedback' })
  })

  test('skips checked categories whose content is missing instead of failing', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'e2e.capturePrimaryView') return Promise.reject(new Error('capture failed'))
      if (command === 'feedback.previewBundle') {
        // The real backend localizes this; the mock returns raw keys.
        const skippedLabels = ['taskInfo', 'screenshot']
        return Promise.resolve({
          ...previewResult,
          skipped: ['taskInfo', 'screenshot'],
          warnings: [`workbench.feedback_skipped_missing:${skippedLabels.join('、')}`],
          entries: previewResult.entries.filter(entry => entry.category === 'report'),
        })
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`))
    })
    const getTaskContext = vi.fn().mockRejectedValue(new Error('transcript unavailable'))
    render(
      <TaskFeedbackDialog open hasActiveTask getTaskContext={getTaskContext} onClose={vi.fn()} />
    )

    fireEvent.change(screen.getByTestId('task-feedback-note'), {
      target: { value: 'Task context is unavailable' },
    })
    fireEvent.click(screen.getByTestId('task-feedback-group-full-task-checkbox'))
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))

    await waitFor(() =>
      expect(screen.getByTestId('task-feedback-preview-list')).toBeInTheDocument()
    )
    const notice = screen.getByTestId('task-feedback-skipped-notice')
    expect(notice).toHaveTextContent('workbench.feedback_skipped_missing')
    expect(screen.getByText(/taskInfo、screenshot/)).toBeInTheDocument()
    expect(screen.queryByText(/feedback_export_failed/)).not.toBeInTheDocument()
  })

  test('lets the user expand previewable entries and inspect redacted content', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'e2e.capturePrimaryView')
        return Promise.resolve('data:image/png;base64,aGVsbG8=')
      if (command === 'feedback.previewBundle') return Promise.resolve(previewResult)
      return Promise.reject(new Error(`Unexpected command: ${command}`))
    })
    render(
      <TaskFeedbackDialog
        open
        hasActiveTask
        getTaskContext={async () => ({ taskId: 'task-1' })}
        onClose={vi.fn()}
      />
    )

    fireEvent.change(screen.getByTestId('task-feedback-note'), {
      target: { value: 'The task context contains the failure details' },
    })
    fireEvent.click(screen.getByTestId('task-feedback-group-full-task-checkbox'))
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))
    await waitFor(() =>
      expect(screen.getByTestId('task-feedback-preview-list')).toBeInTheDocument()
    )

    // The preview is grouped by category; expand a group to see its files.
    fireEvent.click(screen.getByTestId('task-feedback-preview-category-task'))
    fireEvent.click(screen.getByTestId('task-feedback-preview-entry-context/task.json'))
    const content = screen.getByTestId('task-feedback-preview-content')
    expect(content).toHaveTextContent('{"task":{"id":"task-1"}}')

    // Binary entries are not expandable.
    fireEvent.click(screen.getByTestId('task-feedback-preview-category-screenshot'))
    expect(screen.getByTestId('task-feedback-preview-entry-screenshot.png')).toBeDisabled()
  })

  test('confirms the staged bundle only after the user approves the preview', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'e2e.capturePrimaryView')
        return Promise.resolve('data:image/png;base64,aGVsbG8=')
      if (command === 'feedback.previewBundle') return Promise.resolve(previewResult)
      if (command === 'feedback.confirmBundle') {
        return Promise.resolve({ reportId: 'WF-1', path: '/tmp/wework-feedback-WF-1.zip' })
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`))
    })
    render(
      <TaskFeedbackDialog
        open
        hasActiveTask
        getTaskContext={async () => ({ taskId: 'task-1' })}
        onClose={vi.fn()}
      />
    )

    fireEvent.change(screen.getByTestId('task-feedback-note'), {
      target: { value: 'Export this problem for manual sharing' },
    })
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))
    await waitFor(() =>
      expect(screen.getByTestId('task-feedback-confirm-button')).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId('task-feedback-confirm-button'))

    await waitFor(() => expect(screen.getByText('已导出')).toBeInTheDocument())
    expect(invokeMock).toHaveBeenCalledWith('feedback.confirmBundle', {
      decision: { stagingId: 'staging-1' },
    })
    expect(screen.getByText('/tmp/wework-feedback-WF-1.zip')).toBeInTheDocument()
  })
})
