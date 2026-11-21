import '@testing-library/jest-dom'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
  registerTaskTimingPanel,
  TaskTimingPanel,
} from '@/features/tasks/components/timing/TaskTimingPanel'
import type { TaskTimingResponse } from '@/apis/tasks'

const mockGetTaskTiming = jest.fn()
const mockTranslate = (key: string, options?: Record<string, string>) =>
  options ? `${key}:${Object.values(options).join(',')}` : key

jest.mock('@/apis/tasks', () => ({
  taskApis: {
    getTaskTiming: (taskId: number) => mockGetTaskTiming(taskId),
  },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))

registerTaskTimingPanel()

const timingResponse: TaskTimingResponse = {
  task_id: 42,
  owner_user_id: 7,
  wall_time_ms: 17_000,
  session_start_at_ms: 3_000,
  session_end_at_ms: 21_000,
  triage: [
    { kind: 'agent', duration_ms: 8_000 },
    { kind: 'tool', duration_ms: 4_000 },
    { kind: 'gap', duration_ms: 1_000 },
  ],
  coverage: [
    { kind: 'agent', duration_ms: 12_000 },
    { kind: 'tool', duration_ms: 4_000 },
  ],
  top_suspects: [
    {
      span_id: 'agent-1',
      label: 'Agent execution',
      category: 'agent',
      duration_ms: 12_000,
      status: 'completed',
      suggestion: 'inspect_model',
    },
    {
      span_id: 'tool-1',
      label: 'pnpm test',
      category: 'tool',
      duration_ms: 4_000,
      status: 'completed',
      suggestion: 'inspect_registry',
    },
  ],
  spans: [
    {
      id: 1,
      subtask_id: 11,
      turn_id: '11',
      parent_span_id: '',
      span_id: 'agent-1',
      kind: 'agent',
      actor_id: 'agent',
      actor_type: 'runtime',
      actor_label: 'Agent execution',
      status: 'completed',
      start_at_ms: 5_000,
      end_at_ms: 17_000,
      duration_ms: 12_000,
      clock: 'executor-manager',
      source: 'executor',
      metadata: {},
    },
    {
      id: 2,
      subtask_id: 11,
      turn_id: '11',
      parent_span_id: '',
      span_id: 'tool-1',
      kind: 'tool',
      actor_id: 'tool',
      actor_type: 'runtime',
      actor_label: 'pnpm test',
      status: 'completed',
      start_at_ms: 5_000,
      end_at_ms: 9_000,
      duration_ms: 4_000,
      clock: 'executor-manager',
      source: 'executor',
      metadata: {},
    },
  ],
}

const emptyResponse: TaskTimingResponse = {
  task_id: 42,
  owner_user_id: 7,
  wall_time_ms: null,
  triage: [],
  coverage: [],
  top_suspects: [],
  spans: [],
  has_spans: false,
}

const localizedStatusResponse: TaskTimingResponse = {
  ...timingResponse,
  spans: [
    {
      ...timingResponse.spans[0],
      status: 'running',
    },
    {
      ...timingResponse.spans[1],
      status: 'untranslated_status',
    },
  ],
}

const interiorGapResponse: TaskTimingResponse = {
  ...timingResponse,
  spans: [
    { ...timingResponse.spans[0], start_at_ms: 5_000, end_at_ms: 9_000, duration_ms: 4_000 },
    { ...timingResponse.spans[1], start_at_ms: 15_000, end_at_ms: 17_000, duration_ms: 2_000 },
  ],
}

function renderPanel() {
  return render(
    <TaskTimingPanel panelProps={{ taskId: 42 }} onClose={jest.fn()} embedded={false} />
  )
}

describe('TaskTimingPanel', () => {
  beforeEach(() => {
    mockGetTaskTiming.mockReset()
  })

  it('renders triage and top suspects from observed timing data', async () => {
    mockGetTaskTiming.mockResolvedValue(timingResponse)
    renderPanel()

    expect(mockGetTaskTiming).toHaveBeenCalledWith(42)
    expect(await screen.findByTestId('task-timing-triage')).toBeInTheDocument()
    expect(screen.getAllByTestId('task-timing-triage-item')).toHaveLength(3)
    expect(screen.getByText('timing.summary.agent')).toBeInTheDocument()
    expect(screen.getAllByText('12s')).toHaveLength(1)
    expect(screen.getAllByTestId('task-timing-suspect')).toHaveLength(2)
    expect(screen.getByText('pnpm test')).toBeInTheDocument()
    expect(
      screen.getByText('timing.suggestions.inspect_registry:inspect_registry')
    ).toBeInTheDocument()
    expect(screen.getByText('timing.summary.wall_time:17s')).toBeInTheDocument()
    const bars = screen.getAllByTestId('task-timing-triage-item')
    expect(bars[0]).toBeInTheDocument()
  })

  it('shows loading, empty, and error states without inventing timing', async () => {
    const pending = new Promise<TaskTimingResponse>(() => {})
    mockGetTaskTiming.mockReturnValueOnce(pending)
    const { rerender } = renderPanel()
    expect(screen.getByTestId('task-timing-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('task-timing-triage')).not.toBeInTheDocument()

    mockGetTaskTiming.mockResolvedValueOnce(emptyResponse)
    rerender(<TaskTimingPanel panelProps={{ taskId: 43 }} onClose={jest.fn()} embedded={false} />)
    expect(await screen.findByTestId('task-timing-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('task-timing-triage')).not.toBeInTheDocument()

    mockGetTaskTiming.mockRejectedValueOnce(new Error('timing unavailable'))
    rerender(<TaskTimingPanel panelProps={{ taskId: 44 }} onClose={jest.fn()} embedded={false} />)
    expect(await screen.findByTestId('task-timing-error')).toBeInTheDocument()
    expect(screen.getByText('timing unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('task-timing-triage')).not.toBeInTheDocument()
  })

  it('retries after a timing request fails', async () => {
    const user = userEvent.setup()
    mockGetTaskTiming
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(timingResponse)
    renderPanel()

    await screen.findByTestId('task-timing-error')
    await user.click(screen.getByTestId('task-timing-retry'))

    expect(await screen.findByTestId('task-timing-triage')).toBeInTheDocument()
    expect(mockGetTaskTiming).toHaveBeenCalledTimes(2)
  })

  it('ignores stale timing responses and rejections after the task scope changes', async () => {
    let resolveTask42!: (value: TaskTimingResponse) => void
    let rejectTask42!: (reason: unknown) => void
    let resolveTask44!: (value: TaskTimingResponse) => void
    mockGetTaskTiming
      .mockImplementationOnce(
        () =>
          new Promise<TaskTimingResponse>((resolve, reject) => {
            resolveTask42 = resolve
            rejectTask42 = reject
          })
      )
      .mockResolvedValueOnce(emptyResponse)
      .mockImplementationOnce(
        () => new Promise<TaskTimingResponse>(resolve => (resolveTask44 = resolve))
      )

    const { rerender } = renderPanel()
    rerender(<TaskTimingPanel panelProps={{ taskId: 43 }} onClose={jest.fn()} embedded={false} />)

    expect(await screen.findByTestId('task-timing-empty')).toBeInTheDocument()
    await act(async () => {
      resolveTask42(timingResponse)
    })
    expect(screen.getByTestId('task-timing-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('task-timing-triage')).not.toBeInTheDocument()

    rerender(<TaskTimingPanel panelProps={{ taskId: 44 }} onClose={jest.fn()} embedded={false} />)
    expect(await screen.findByTestId('task-timing-loading')).toBeInTheDocument()
    await act(async () => {
      rejectTask42(new Error('stale rejection'))
    })
    expect(screen.getByTestId('task-timing-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('task-timing-error')).not.toBeInTheDocument()
    await act(async () => {
      resolveTask44(emptyResponse)
    })
  })

  it('reveals timeline spans with a common wall-clock scale', async () => {
    const user = userEvent.setup()
    mockGetTaskTiming.mockResolvedValue(timingResponse)
    renderPanel()

    await screen.findByTestId('task-timing-triage')
    expect(screen.queryByTestId('task-timing-timeline-details')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('task-timing-timeline-toggle'))

    const details = screen.getByTestId('task-timing-timeline-details')
    expect(screen.getAllByTestId('task-timing-span')).toHaveLength(2)
    const bars = screen.getAllByTestId('task-timing-span-bar')
    expect(Number.parseFloat(bars[0].style.left)).toBeCloseTo((2 / 18) * 100, 10)
    expect(Number.parseFloat(bars[0].style.width)).toBeCloseTo((12 / 18) * 100, 10)
    expect(Number.parseFloat(bars[1].style.left)).toBeCloseTo((2 / 18) * 100, 10)
    expect(Number.parseFloat(bars[1].style.width)).toBeCloseTo((4 / 18) * 100, 10)
    expect(
      Number.parseFloat(screen.getByTestId('task-timing-leading-gap').style.width)
    ).toBeCloseTo((2 / 18) * 100, 10)
    expect(
      Number.parseFloat(screen.getByTestId('task-timing-trailing-gap').style.width)
    ).toBeCloseTo((4 / 18) * 100, 10)
    expect(screen.getByTestId('task-timing-leading-gap-label')).toHaveTextContent(
      'timing.timeline.leading_gap:2s'
    )
    expect(screen.getByTestId('task-timing-trailing-gap-label')).toHaveTextContent(
      'timing.timeline.trailing_gap:4s'
    )
    expect(within(details).getByText('Agent execution')).toBeInTheDocument()
    expect(within(details).getByText('pnpm test')).toBeInTheDocument()
  })

  it('localizes known span statuses and falls back to the raw status', async () => {
    const user = userEvent.setup()
    mockGetTaskTiming.mockResolvedValue(localizedStatusResponse)
    renderPanel()

    await screen.findByTestId('task-timing-triage')
    await user.click(screen.getByTestId('task-timing-timeline-toggle'))

    const statuses = screen.getAllByTestId('task-timing-span-status')
    expect(statuses[0]).toHaveTextContent('timing.status.running')
    expect(statuses[1]).toHaveTextContent('untranslated_status')
  })

  it('marks interior unobserved intervals on the shared timeline', async () => {
    const user = userEvent.setup()
    mockGetTaskTiming.mockResolvedValue(interiorGapResponse)
    renderPanel()

    await screen.findByTestId('task-timing-triage')
    await user.click(screen.getByTestId('task-timing-timeline-toggle'))

    const gap = screen.getByTestId('task-timing-interior-gap')
    expect(Number.parseFloat(gap.style.left)).toBeCloseTo((6 / 18) * 100, 10)
    expect(Number.parseFloat(gap.style.width)).toBeCloseTo((6 / 18) * 100, 10)
    expect(screen.getByTestId('task-timing-interior-gap-label')).toHaveTextContent(
      'timing.timeline.interior_gap:6s'
    )
  })

  it('does not invent absolute timestamps when no timeline anchor exists', async () => {
    const user = userEvent.setup()
    mockGetTaskTiming.mockResolvedValue({
      ...timingResponse,
      session_start_at_ms: null,
      session_end_at_ms: null,
      spans: [
        {
          ...timingResponse.spans[0],
          start_at_ms: null,
          end_at_ms: null,
          duration_ms: 12_000,
        },
      ],
    })
    renderPanel()

    await screen.findByTestId('task-timing-triage')
    await user.click(screen.getByTestId('task-timing-timeline-toggle'))

    const times = screen.getAllByText('--')
    expect(times.length).toBeGreaterThanOrEqual(2)
    expect(screen.getByTestId('task-timing-span-bar')).toHaveStyle({ width: '0%' })
  })

  it('uses semantic theme classes and a responsive layout', async () => {
    mockGetTaskTiming.mockResolvedValue(timingResponse)
    const { container } = renderPanel()

    expect(await screen.findByTestId('task-timing-panel')).toHaveClass(
      'bg-base',
      'text-text-primary'
    )
    const suspect = screen.getAllByTestId('task-timing-suspect')[0]
    expect(suspect).toHaveClass('border-border', 'bg-surface')
    expect(suspect.firstChild).toHaveClass('flex-col', 'sm:flex-row')
    expect(container.querySelector('.bg-muted')).toBeInTheDocument()
  })
})
