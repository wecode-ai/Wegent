import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { TaskFeedbackDialog } from './TaskFeedbackDialog'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))
const trackMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
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
    invokeMock.mockReset()
    trackMock.mockReset()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })
  })

  test('requires a problem description and selects standard diagnostics by default', () => {
    render(
      <TaskFeedbackDialog
        open
        hasActiveTask
        getTaskContext={async () => ({ taskId: 'task-1' })}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText(/运行日志/)).toBeInTheDocument()
    expect(screen.getByTestId('task-feedback-group-standard-checkbox')).toBeChecked()
    expect(screen.getByTestId('task-feedback-group-full-task-checkbox')).not.toBeChecked()
    expect(screen.getByTestId('task-feedback-export-button')).toBeDisabled()
  })

  test('allows user-authored feedback without diagnostic categories', async () => {
    invokeMock.mockResolvedValue(previewResult)
    render(
      <TaskFeedbackDialog
        open
        hasActiveTask
        getTaskContext={async () => ({ taskId: 'task-1' })}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-feedback-export-button')).toBeDisabled()

    fireEvent.change(screen.getByTestId('task-feedback-note'), {
      target: { value: 'The toolbar disappears after reconnecting' },
    })

    expect(screen.getByTestId('task-feedback-export-button')).toBeEnabled()
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))
    await screen.findByTestId('task-feedback-preview-list')

    expect(invokeMock).toHaveBeenCalledWith(
      'preview_feedback_bundle',
      expect.objectContaining({
        request: expect.objectContaining({
          note: 'The toolbar disappears after reconnecting',
          attachments: [],
        }),
      })
    )
  })

  test('pastes files into the feedback and includes them in the preview bundle', async () => {
    const previewWithAttachment = {
      ...previewResult,
      entries: [
        ...previewResult.entries,
        {
          category: 'attachments',
          archivePath: 'attachments/1-console.txt',
          sizeBytes: 13,
          previewable: true,
          content: 'console output',
          truncated: false,
        },
      ],
    }
    invokeMock.mockImplementation((command: string) => {
      if (command === 'preview_feedback_bundle') return Promise.resolve(previewWithAttachment)
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
    const attachment = new File(['console output'], 'console.txt', { type: 'text/plain' })

    fireEvent.paste(screen.getByTestId('task-feedback-note'), {
      clipboardData: { files: [attachment] },
    })
    fireEvent.change(screen.getByTestId('task-feedback-note'), {
      target: { value: 'The console output may help explain the problem' },
    })

    expect(await screen.findByText('console.txt')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))
    await screen.findByTestId('task-feedback-preview-list')

    expect(invokeMock).toHaveBeenCalledWith(
      'preview_feedback_bundle',
      expect.objectContaining({
        request: expect.objectContaining({
          attachments: [
            {
              name: 'console.txt',
              mimeType: 'text/plain',
              dataBase64: 'Y29uc29sZSBvdXRwdXQ=',
            },
          ],
        }),
      })
    )
    expect(screen.getByText('用户提供内容（含隐私内容）')).toBeInTheDocument()
    expect(screen.getByText('用户附件')).toBeInTheDocument()
  })

  test('adds files through the attachment picker', async () => {
    invokeMock.mockResolvedValue(previewResult)
    render(
      <TaskFeedbackDialog
        open
        hasActiveTask
        getTaskContext={async () => ({ taskId: 'task-1' })}
        onClose={vi.fn()}
      />
    )
    const attachment = new File(['details'], 'details.txt', { type: 'text/plain' })

    fireEvent.change(screen.getByTestId('task-feedback-attachment-input'), {
      target: { files: [attachment] },
    })

    expect(await screen.findByText('details.txt')).toBeInTheDocument()
    expect(screen.getByTestId('task-feedback-export-button')).toBeDisabled()

    fireEvent.change(screen.getByTestId('task-feedback-note'), {
      target: { value: 'The attached details explain the problem' },
    })
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))
    await screen.findByTestId('task-feedback-preview-list')

    expect(invokeMock).toHaveBeenCalledWith(
      'preview_feedback_bundle',
      expect.objectContaining({
        request: expect.objectContaining({
          attachments: [
            {
              name: 'details.txt',
              mimeType: 'text/plain',
              dataBase64: 'ZGV0YWlscw==',
            },
          ],
        }),
      })
    )
  })

  test('removes a pasted attachment before previewing', async () => {
    invokeMock.mockResolvedValue(previewResult)
    render(
      <TaskFeedbackDialog
        open
        hasActiveTask
        getTaskContext={async () => ({ taskId: 'task-1' })}
        onClose={vi.fn()}
      />
    )
    const attachment = new File(['image'], 'screenshot.png', { type: 'image/png' })

    fireEvent.paste(screen.getByTestId('task-feedback-note'), {
      clipboardData: { files: [attachment] },
    })
    fireEvent.change(screen.getByTestId('task-feedback-note'), {
      target: { value: 'The screenshot is no longer needed' },
    })
    await screen.findByText('screenshot.png')
    fireEvent.click(screen.getByTestId('task-feedback-remove-attachment-0'))

    expect(screen.queryByText('screenshot.png')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))
    await screen.findByTestId('task-feedback-preview-list')

    expect(invokeMock).toHaveBeenCalledWith(
      'preview_feedback_bundle',
      expect.objectContaining({
        request: expect.objectContaining({ attachments: [] }),
      })
    )
  })

  test('keeps standard diagnostics available in new-conversation state', () => {
    render(
      <TaskFeedbackDialog
        open
        hasActiveTask={false}
        getTaskContext={async () => ({})}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-feedback-group-full-task-checkbox')).toBeDisabled()
    expect(screen.getByTestId('task-feedback-group-standard-checkbox')).toBeEnabled()
    expect(screen.getAllByText('workbench.feedback_requires_task')).toHaveLength(1)
    expect(screen.getByTestId('task-feedback-export-button')).toBeDisabled()

    fireEvent.change(screen.getByTestId('task-feedback-note'), {
      target: { value: 'The new conversation screen is broken' },
    })
    expect(screen.getByTestId('task-feedback-export-button')).toBeEnabled()
  })

  test('builds a preview before writing any exported file', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'capture_main_webview')
        return Promise.resolve('data:image/png;base64,aGVsbG8=')
      if (command === 'preview_feedback_bundle') return Promise.resolve(previewResult)
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
      'preview_feedback_bundle',
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
    expect(invokeMock).not.toHaveBeenCalledWith('confirm_feedback_bundle', expect.anything())
  })

  test('submits the exact previewed bundle through the configured feedback API', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'preview_feedback_bundle') return Promise.resolve(previewResult)
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
    expect(invokeMock).not.toHaveBeenCalledWith('confirm_feedback_bundle', expect.anything())
  })

  test('logs a safe failure classification with the report ID when submission fails', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'preview_feedback_bundle') return Promise.resolve(previewResult)
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

  test('never touches task context or the screenshot without opting into full task data', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'preview_feedback_bundle') return Promise.resolve(previewResult)
      return Promise.reject(new Error(`Unexpected command: ${command}`))
    })
    const getTaskContext = vi.fn().mockResolvedValue({ taskId: 'task-1' })
    render(
      <TaskFeedbackDialog open hasActiveTask getTaskContext={getTaskContext} onClose={vi.fn()} />
    )

    fireEvent.click(screen.getByTestId('task-feedback-group-standard-checkbox'))
    fireEvent.change(screen.getByTestId('task-feedback-note'), {
      target: { value: 'The toolbar disappears after reconnecting' },
    })
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))

    await waitFor(() =>
      expect(screen.getByTestId('task-feedback-preview-list')).toBeInTheDocument()
    )
    expect(getTaskContext).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalledWith('capture_main_webview')
    expect(invokeMock).toHaveBeenCalledWith(
      'preview_feedback_bundle',
      expect.objectContaining({
        request: expect.objectContaining({
          includeRuntimeLogs: false,
          includeTaskInfo: false,
          includeScreenshot: false,
          includeSystemInfo: false,
          taskContext: null,
          screenshotDataUrl: null,
        }),
      })
    )
  })

  test('shows the dialog while capturing and hides it only during screenshot capture', async () => {
    let resolveCapture: (value: string) => void = () => undefined
    const capture = new Promise<string>(resolve => {
      resolveCapture = resolve
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'capture_main_webview') return capture
      if (command === 'preview_feedback_bundle') return Promise.resolve(previewResult)
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
      target: { value: 'The captured window is incorrect' },
    })
    fireEvent.click(screen.getByTestId('task-feedback-group-full-task-checkbox'))
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))

    await waitFor(() => {
      const overlay = screen.getByTestId('task-feedback-dialog-overlay')
      expect(overlay).toHaveClass('invisible')
      expect(overlay).toHaveStyle({ visibility: 'hidden' })
    })
    await act(async () => resolveCapture('data:image/png;base64,aGVsbG8='))
    await waitFor(() =>
      expect(screen.getByTestId('task-feedback-preview-list')).toBeInTheDocument()
    )
    expect(screen.getByTestId('task-feedback-dialog-overlay')).not.toHaveClass('invisible')
    expect(screen.getByTestId('task-feedback-dialog-overlay')).not.toHaveStyle({
      visibility: 'hidden',
    })
  })

  test('skips checked categories whose content is missing instead of failing', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'capture_main_webview') return Promise.reject(new Error('capture failed'))
      if (command === 'preview_feedback_bundle') {
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
      if (command === 'capture_main_webview')
        return Promise.resolve('data:image/png;base64,aGVsbG8=')
      if (command === 'preview_feedback_bundle') return Promise.resolve(previewResult)
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
      if (command === 'capture_main_webview')
        return Promise.resolve('data:image/png;base64,aGVsbG8=')
      if (command === 'preview_feedback_bundle') return Promise.resolve(previewResult)
      if (command === 'confirm_feedback_bundle') {
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
    expect(invokeMock).toHaveBeenCalledWith('confirm_feedback_bundle', {
      decision: { stagingId: 'staging-1' },
    })
    expect(screen.getByText('/tmp/wework-feedback-WF-1.zip')).toBeInTheDocument()
  })

  test('discards the staged bundle when the user goes back from the preview', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'capture_main_webview')
        return Promise.resolve('data:image/png;base64,aGVsbG8=')
      if (command === 'preview_feedback_bundle') return Promise.resolve(previewResult)
      if (command === 'discard_feedback_bundle') return Promise.resolve(null)
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
      target: { value: 'Return to edit this problem' },
    })
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))
    await waitFor(() => expect(screen.getByText('返回')).toBeInTheDocument())
    fireEvent.click(screen.getByText('返回'))

    await waitFor(() =>
      expect(screen.getByTestId('task-feedback-group-standard-checkbox')).toBeInTheDocument()
    )
    expect(invokeMock).toHaveBeenCalledWith('discard_feedback_bundle', {
      decision: { stagingId: 'staging-1' },
    })
    expect(invokeMock).not.toHaveBeenCalledWith('confirm_feedback_bundle', expect.anything())
  })

  test('discards the staged bundle when the dialog is closed from the preview', async () => {
    const onClose = vi.fn()
    invokeMock.mockImplementation((command: string) => {
      if (command === 'capture_main_webview')
        return Promise.resolve('data:image/png;base64,aGVsbG8=')
      if (command === 'preview_feedback_bundle') return Promise.resolve(previewResult)
      if (command === 'discard_feedback_bundle') return Promise.resolve(null)
      return Promise.reject(new Error(`Unexpected command: ${command}`))
    })
    render(
      <TaskFeedbackDialog
        open
        hasActiveTask
        getTaskContext={async () => ({ taskId: 'task-1' })}
        onClose={onClose}
      />
    )

    fireEvent.change(screen.getByTestId('task-feedback-note'), {
      target: { value: 'Close this problem without submitting' },
    })
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))
    await waitFor(() =>
      expect(screen.getByTestId('task-feedback-preview-list')).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId('task-feedback-close-button'))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(invokeMock).toHaveBeenCalledWith('discard_feedback_bundle', {
      decision: { stagingId: 'staging-1' },
    })
  })
})
