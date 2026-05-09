// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { taskApis } from '@/apis/tasks'
import type { PipelineStageInfo } from '@/apis/tasks'
import PipelineStageIndicator from '@/features/tasks/components/chat/PipelineStageIndicator'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/apis/tasks', () => ({
  taskApis: {
    getPipelineStageInfo: jest.fn(),
  },
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

    expect(button).toHaveTextContent('pipeline.next_step')

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

    await screen.findByText(/pipeline\.progress_label/)

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

    await screen.findByText(/pipeline\.progress_label/)

    expect(screen.queryByTestId('pipeline-next-step-button')).not.toBeInTheDocument()
  })
})
