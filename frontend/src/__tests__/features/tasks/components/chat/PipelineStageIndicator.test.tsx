// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { taskApis } from '@/apis/tasks'
import type { PipelineStageInfo } from '@/apis/tasks'
import PipelineStageIndicator from '@/features/tasks/components/chat/PipelineStageIndicator'

const mockTranslations: Record<string, Record<string, string>> = {
  chat: {
    'pipeline.next_step': 'Next step',
    'pipeline.progress_label': 'Pipeline Progress',
    'pipeline.start_node': 'Start',
    'pipeline.stage_started': 'Started',
    'pipeline.stage_completed': 'Completed',
    'pipeline.stage_running': 'Running',
    'pipeline.stage_awaiting_confirmation': 'Awaiting Confirmation',
    'pipeline.stage_failed': 'Failed',
    'pipeline.stage_pending': 'Pending',
    'pipeline.awaiting_confirmation': 'Awaiting Confirmation',
    'pipeline.requires_confirmation': 'Requires confirmation',
  },
}

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string) => {
      if (key.includes(':')) {
        const [keyNamespace, namespacedKey] = key.split(':')
        return mockTranslations[keyNamespace]?.[namespacedKey] ?? key
      }

      return mockTranslations[namespace ?? 'common']?.[key] ?? key
    },
  }),
}))

jest.mock('@/apis/tasks', () => ({
  taskApis: {
    getPipelineStageInfo: jest.fn(),
  },
}))

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    socket: null,
    isConnected: false,
    registerChatHandlers: jest.fn(() => jest.fn()),
  }),
}))

const mockGetPipelineStageInfo = taskApis.getPipelineStageInfo as jest.MockedFunction<
  typeof taskApis.getPipelineStageInfo
>

const createStageInfo = (overrides: Partial<PipelineStageInfo> = {}): PipelineStageInfo => ({
  current_stage: 0,
  total_stages: 3,
  current_stage_name: 'Design',
  is_pending_confirmation: true,
  stages: [
    {
      index: 0,
      name: 'Design',
      require_confirmation: true,
      status: 'pending_confirmation',
    },
    {
      index: 1,
      name: 'Build',
      require_confirmation: true,
      status: 'pending',
    },
    {
      index: 2,
      name: 'Review',
      require_confirmation: false,
      status: 'pending',
    },
  ],
  ...overrides,
})

const renderIndicator = (
  props: Partial<React.ComponentProps<typeof PipelineStageIndicator>> = {}
) => {
  const defaultProps: React.ComponentProps<typeof PipelineStageIndicator> = {
    taskId: 42,
    taskStatus: 'PENDING_CONFIRMATION',
    collaborationModel: 'pipeline',
  }

  return render(<PipelineStageIndicator {...defaultProps} {...props} />)
}

describe('PipelineStageIndicator', () => {
  beforeEach(() => {
    mockGetPipelineStageInfo.mockReset()
  })

  it('renders the next-step button and calls back with stage info when pending confirmation has a next stage', async () => {
    const user = userEvent.setup()
    const stageInfo = createStageInfo()
    const onNextStepClick = jest.fn()
    mockGetPipelineStageInfo.mockResolvedValue(stageInfo)

    renderIndicator({ onNextStepClick })

    const button = await screen.findByTestId('pipeline-next-step-button')

    expect(button).toHaveTextContent('Next step')

    await user.click(button)

    expect(onNextStepClick).toHaveBeenCalledTimes(1)
    expect(onNextStepClick).toHaveBeenCalledWith(stageInfo)
  })

  it('disables the next-step button when continuing is not allowed', async () => {
    mockGetPipelineStageInfo.mockResolvedValue(createStageInfo())

    renderIndicator({ canContinueToNextStage: false })

    expect(await screen.findByTestId('pipeline-next-step-button')).toBeDisabled()
  })

  it('does not render the next-step button when the pipeline is not pending confirmation', async () => {
    mockGetPipelineStageInfo.mockResolvedValue(
      createStageInfo({
        is_pending_confirmation: false,
        stages: [
          {
            index: 0,
            name: 'Design',
            require_confirmation: true,
            status: 'running',
          },
          {
            index: 1,
            name: 'Build',
            require_confirmation: true,
            status: 'pending',
          },
          {
            index: 2,
            name: 'Review',
            require_confirmation: false,
            status: 'pending',
          },
        ],
      })
    )

    renderIndicator()

    await screen.findByText(/Pipeline Progress/)

    expect(screen.queryByTestId('pipeline-next-step-button')).not.toBeInTheDocument()
  })

  it('does not render the next-step button on the final stage', async () => {
    mockGetPipelineStageInfo.mockResolvedValue(
      createStageInfo({
        current_stage: 2,
        current_stage_name: 'Review',
        stages: [
          {
            index: 0,
            name: 'Design',
            require_confirmation: true,
            status: 'completed',
          },
          {
            index: 1,
            name: 'Build',
            require_confirmation: true,
            status: 'completed',
          },
          {
            index: 2,
            name: 'Review',
            require_confirmation: false,
            status: 'pending_confirmation',
          },
        ],
      })
    )

    renderIndicator()

    await screen.findByText(/Pipeline Progress/)

    expect(screen.queryByTestId('pipeline-next-step-button')).not.toBeInTheDocument()
  })

  it('ignores stale pipeline stage responses after switching to a non-pipeline task', async () => {
    let resolveStageInfo: (stageInfo: PipelineStageInfo) => void = () => {}
    const pendingStageInfo = new Promise<PipelineStageInfo>(resolve => {
      resolveStageInfo = resolve
    })
    mockGetPipelineStageInfo.mockReturnValue(pendingStageInfo)

    const onStageInfoChange = jest.fn()

    const { rerender } = renderIndicator({ onStageInfoChange })

    rerender(
      <PipelineStageIndicator
        taskId={43}
        taskStatus="COMPLETED"
        collaborationModel="route"
        onStageInfoChange={onStageInfoChange}
      />
    )

    await act(async () => {
      resolveStageInfo(createStageInfo())
      await pendingStageInfo
    })

    await waitFor(() => {
      expect(screen.queryByText(/Pipeline Progress/)).not.toBeInTheDocument()
    })
    expect(onStageInfoChange).not.toHaveBeenCalledWith(expect.objectContaining({ total_stages: 3 }))
  })

  it('clears previous stage info while loading a different pipeline task', async () => {
    let resolveNextStageInfo: (stageInfo: PipelineStageInfo) => void = () => {}
    const nextStageInfo = new Promise<PipelineStageInfo>(resolve => {
      resolveNextStageInfo = resolve
    })

    mockGetPipelineStageInfo
      .mockResolvedValueOnce(createStageInfo({ current_stage: 0 }))
      .mockReturnValueOnce(nextStageInfo)

    const { rerender } = renderIndicator({ taskId: 42 })

    expect(await screen.findByText(/Pipeline Progress/)).toHaveTextContent('1/3')

    rerender(
      <PipelineStageIndicator taskId={43} taskStatus="RUNNING" collaborationModel="pipeline" />
    )

    expect(screen.queryByText(/Pipeline Progress/)).not.toBeInTheDocument()

    await act(async () => {
      resolveNextStageInfo(createStageInfo({ current_stage: 1 }))
      await nextStageInfo
    })

    expect(await screen.findByText(/Pipeline Progress/)).toHaveTextContent('2/3')
  })
})
