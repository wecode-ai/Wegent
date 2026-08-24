import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { RuntimeTaskExecutionOverlay } from './RuntimeTaskExecutionOverlay'

const reloadRuntimeTranscript = vi.fn()

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => ({
    state: {
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'device-1',
            projectId: null,
            tasks: [{ taskId: 'codex-queue-1', title: 'Implement quicksort' }],
          },
        ],
        totalTasks: 1,
      },
      devices: [{ device_id: 'device-1', name: 'Cloud Device' }],
    },
    cancelRuntimeTask: vi.fn(),
    openRuntimeTask: vi.fn(),
  }),
}))

vi.mock('@/components/layout/useWorkbenchPaneSession', () => ({
  useWorkbenchPaneSession: () => ({
    messages: [],
    transcriptError: 'runtime.tasks.transcript timed out',
    reloadRuntimeTranscript,
    transcriptLoading: false,
    waitingForAssistant: false,
    transcriptHasMoreBefore: false,
    transcriptLoadingMoreBefore: false,
    transcriptLoadingFullContent: false,
    turnNavigation: [],
    loadedTranscriptRanges: [],
    loadMoreTranscriptBefore: vi.fn(),
    loadFullTranscript: vi.fn(),
    loadTranscriptTurnNavigationItem: vi.fn(),
    loadTranscriptGap: vi.fn(),
    status: {
      taskExecution: {
        running: true,
      },
    },
  }),
}))

describe('RuntimeTaskExecutionOverlay', () => {
  it('separates transcript timeout from the running execution and offers retry', async () => {
    const user = userEvent.setup()

    render(
      <RuntimeTaskExecutionOverlay
        address={{ deviceId: 'device-1', taskId: 'codex-queue-1' }}
        senderName="新机器人"
        runStatus="running"
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('runtime-execution-detail-status')).toHaveTextContent('执行中')
    expect(screen.getByTestId('runtime-execution-detail-transcript-error')).toHaveTextContent(
      '暂时无法加载会话'
    )
    expect(screen.getByTestId('runtime-execution-detail-transcript-error')).toHaveTextContent(
      '任务仍在执行'
    )

    await user.click(screen.getByTestId('runtime-execution-detail-transcript-retry'))
    expect(reloadRuntimeTranscript).toHaveBeenCalledTimes(1)
  })
})
