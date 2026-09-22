import { render as renderComponent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { RuntimeTaskExecutionOverlay } from './RuntimeTaskExecutionOverlay'

import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import type { ReactElement } from 'react'

function render(element: ReactElement) {
  return renderComponent(
    <RuntimeTaskLifecycleProvider store={new RuntimeTaskLifecycleStore()}>
      {element}
    </RuntimeTaskLifecycleProvider>
  )
}

const reloadRuntimeTranscript = vi.fn()

vi.mock('@/features/workbench/useWorkbench', async importOriginal => ({
  ...(await importOriginal<typeof import('@/features/workbench/useWorkbench')>()),
  useWorkbenchPaneContext: () => ({
    state: {
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'device-1',
            projectId: null,
            tasks: [
              {
                taskId: 'codex-queue-1',
                title: 'Implement quicksort',
                modelSelection: {
                  modelName: 'current-cloud-model',
                  modelType: 'user',
                  options: {},
                },
              },
            ],
          },
        ],
        totalTasks: 1,
      },
      devices: [
        {
          device_id: 'device-1',
          name: 'Cloud Device',
          runtime_routes: [
            {
              kind: 'cloud-relay',
              device_id: 'device-1',
              runtime_device_id: 'runtime-device-1',
              status: 'online',
            },
          ],
        },
      ],
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
    turnNavigation: [],
    loadedTranscriptRanges: [],
    loadMoreTranscriptBefore: vi.fn(),
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
  it('shows the runtime model instead of stale activity metadata', () => {
    render(
      <RuntimeTaskExecutionOverlay
        address={{ deviceId: 'device-1', taskId: 'codex-queue-1' }}
        senderName="Bot"
        modelName="stale-model"
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(/current-cloud-model/)).toBeInTheDocument()
    expect(screen.queryByText(/stale-model/)).not.toBeInTheDocument()
  })

  it('shows the device name when the runtime address uses a route id', () => {
    render(
      <RuntimeTaskExecutionOverlay
        address={{ deviceId: 'runtime-device-1', taskId: 'codex-queue-1' }}
        senderName="Bot"
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText(/执行设备: Cloud Device/)).toBeInTheDocument()
    expect(screen.queryByText(/执行设备: runtime-device-1/)).not.toBeInTheDocument()
  })

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
