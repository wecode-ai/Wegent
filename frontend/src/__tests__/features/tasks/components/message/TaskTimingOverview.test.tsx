'use client'

import { fireEvent, render, screen } from '@testing-library/react'
import { TaskTimingOverview } from '@/features/tasks/components/message/TaskTimingOverview'

describe('TaskTimingOverview', () => {
  it('renders a compact summary and expands a stage waterfall', () => {
    render(
      <TaskTimingOverview
        timing={{
          enqueuedAt: 0,
          dequeuedAt: 2_000,
          instanceCreateStartedAt: 2_000,
          instanceCreateFinishedAt: 3_000,
          instanceReadyAt: 4_000,
          taskDispatchedAt: 4_500,
          agentStartedAt: 5_000,
          agentFinishedAt: 20_000,
          terminalReceivedAt: 20_500,
          queueDurationMs: 2_000,
          createDurationMs: 1_000,
          waitReadyDurationMs: 1_000,
          dispatchDurationMs: 500,
          agentDurationMs: 15_000,
        }}
      />
    )

    expect(screen.getByTestId('task-timing-overview')).toHaveTextContent('排队等待 2s')
    expect(screen.getByTestId('task-timing-overview')).toHaveTextContent('等待就绪 1s')
    expect(screen.getByTestId('task-timing-overview')).toHaveTextContent('Agent 执行 15s')
    expect(screen.queryByTestId('task-timing-waterfall')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('task-timing-overview-toggle'))

    expect(screen.getByTestId('task-timing-waterfall')).toHaveTextContent('容器创建1s')
    expect(screen.getByTestId('task-timing-waterfall')).toHaveTextContent('任务派发0s')
    expect(screen.getByTestId('task-timing-waterfall')).not.toHaveTextContent('终态回调')
  })

  it('hides unavailable timing', () => {
    render(<TaskTimingOverview timing={{ enqueuedAt: 1 }} />)
    expect(screen.queryByTestId('task-timing-overview')).not.toBeInTheDocument()
  })
})
