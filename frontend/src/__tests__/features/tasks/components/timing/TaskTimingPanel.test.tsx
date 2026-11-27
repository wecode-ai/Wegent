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
  task_status: 'COMPLETED',
  wall_time_ms: 17_000,
  observed_ms: 12_000,
  unobserved_ms: 5_000,
  session_start_at_ms: 3_000,
  session_end_at_ms: 21_000,
  triage: [
    { kind: 'agent', duration_ms: 8_000, sample_count: 1, observed: true },
    { kind: 'tool', duration_ms: 4_000, sample_count: 1, observed: true },
    { kind: 'gap', duration_ms: 1_000, sample_count: 0, observed: false },
  ],
  coverage: [
    { kind: 'agent', duration_ms: 12_000, sample_count: 1, observed: true },
    { kind: 'tool', duration_ms: 4_000, sample_count: 1, observed: true },
  ],

  spans: [
    {
      id: 1,
      subtask_id: 11,
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
  task_status: 'RUNNING',
  wall_time_ms: null,
  triage: [],
  coverage: [],
  spans: [],
  has_spans: false,
}

const modelCallTimingResponse: TaskTimingResponse = {
  ...timingResponse,
  spans: [
    timingResponse.spans[0],
    {
      ...timingResponse.spans[0],
      id: 3,
      parent_span_id: 'agent-1',
      span_id: 'model-call-1',
      actor_id: 'provider/model-x',
      actor_type: 'model',
      actor_label: 'Model call: model-x',
      start_at_ms: 6_000,
      end_at_ms: 16_000,
      duration_ms: 10_000,
      metadata: { timeToFirstTokenMs: 2_000 },
    },
  ],
}

const paginatedTimingResponse: TaskTimingResponse = {
  ...timingResponse,
  spans: Array.from({ length: 27 }, (_, index) => ({
    ...timingResponse.spans[0],
    id: index + 1,
    span_id: `span-${index + 1}`,
    actor_label: `Span ${index + 1}`,
    start_at_ms: 5_000 + index * 100,
    end_at_ms: 5_500 + index * 100,
    duration_ms: 500,
  })),
}

const durationSortedTimingResponse: TaskTimingResponse = {
  ...timingResponse,
  spans: [
    { ...timingResponse.spans[0], id: 1, span_id: 'later', start_at_ms: 6_000 },
    { ...timingResponse.spans[1], id: 2, span_id: 'earlier', start_at_ms: 5_000 },
  ],
}

const interiorGapResponse: TaskTimingResponse = {
  ...timingResponse,
  spans: [
    { ...timingResponse.spans[0], start_at_ms: 5_000, end_at_ms: 9_000, duration_ms: 4_000 },
    { ...timingResponse.spans[1], start_at_ms: 15_000, end_at_ms: 17_000, duration_ms: 2_000 },
  ],
}

const waitingUserTimingResponse: TaskTimingResponse = {
  ...timingResponse,
  session_end_at_ms: 200_000,
  spans: [
    timingResponse.spans[0],
    {
      ...timingResponse.spans[1],
      id: 3,
      span_id: 'waiting-user',
      kind: 'waiting_user',
      actor_label: 'Waiting for user',
      start_at_ms: 17_000,
      end_at_ms: 200_000,
      duration_ms: 183_000,
    },
  ],
}

const waitingUserMiddleTimingResponse: TaskTimingResponse = {
  ...timingResponse,
  session_start_at_ms: 0,
  session_end_at_ms: 200_000,
  wall_time_ms: 200_000,
  spans: [
    {
      ...timingResponse.spans[0],
      id: 1,
      span_id: 'agent-before',
      start_at_ms: 0,
      end_at_ms: 50_000,
      duration_ms: 50_000,
    },
    {
      ...timingResponse.spans[0],
      id: 2,
      parent_span_id: 'agent-before',
      span_id: 'model-before',
      actor_id: 'provider/model-x',
      actor_type: 'model',
      actor_label: 'Model call: model-x',
      start_at_ms: 10_000,
      end_at_ms: 40_000,
      duration_ms: 30_000,
    },
    {
      ...timingResponse.spans[0],
      id: 3,
      span_id: 'waiting-user',
      kind: 'waiting_user',
      actor_label: 'Waiting for user',
      start_at_ms: 50_000,
      end_at_ms: 150_000,
      duration_ms: 100_000,
    },
    {
      ...timingResponse.spans[0],
      id: 4,
      span_id: 'agent-after',
      actor_label: 'Agent after waiting',
      start_at_ms: 150_000,
      end_at_ms: 200_000,
      duration_ms: 50_000,
    },
  ],
}

const parallelSubagentResponse: TaskTimingResponse = {
  ...timingResponse,
  triage: [
    { kind: 'subagent', duration_ms: 12_000, sample_count: 2, observed: true },
    { kind: 'gap', duration_ms: 5_000, sample_count: 0, observed: false },
  ],
  spans: [
    {
      ...timingResponse.spans[0],
      id: 3,
      span_id: 'subagent-a',
      kind: 'subagent',
      actor_label: 'Subagent A',
      start_at_ms: 4_000,
      end_at_ms: 12_000,
      duration_ms: 8_000,
    },
    {
      ...timingResponse.spans[1],
      id: 4,
      span_id: 'subagent-b',
      kind: 'subagent',
      actor_label: 'Subagent B',
      start_at_ms: 5_000,
      end_at_ms: 13_000,
      duration_ms: 8_000,
    },
  ],
}

const overlappingOpenSubagentResponse: TaskTimingResponse = {
  ...parallelSubagentResponse,
  spans: [
    {
      ...parallelSubagentResponse.spans[0],
      id: 5,
      span_id: 'subagent-open',
      start_at_ms: 4_000,
      end_at_ms: null,
      duration_ms: undefined,
    },
    {
      ...parallelSubagentResponse.spans[1],
      id: 6,
      span_id: 'subagent-later',
      start_at_ms: 5_000,
      end_at_ms: 13_000,
      duration_ms: 8_000,
    },
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

  it('renders a shared attribution bar, status, coverage, and span table', async () => {
    mockGetTaskTiming.mockResolvedValue(timingResponse)
    renderPanel()

    expect(mockGetTaskTiming).toHaveBeenCalledWith(42)
    expect(await screen.findByTestId('task-timing-attribution-bar')).toBeInTheDocument()
    expect(screen.getByTestId('task-timing-wall-time')).toHaveTextContent('17s')
    expect(screen.getByTestId('task-timing-status')).toHaveTextContent('timing.status.COMPLETED')
    expect(screen.getAllByTestId('task-timing-legend-item')).toHaveLength(3)
    expect(screen.getAllByTestId('task-timing-attribution-segment')).toHaveLength(3)
    expect(screen.getAllByTestId('task-timing-span-row')).toHaveLength(2)
    expect(screen.getByTestId('task-timing-span-pagination')).toHaveTextContent(
      'timing.spans.pagination_range:1,2,2'
    )
    expect(screen.queryByTestId('task-timing-prev-page')).not.toBeInTheDocument()
    expect(screen.getAllByText('Agent execution').length).toBeGreaterThan(0)
    expect(screen.getAllByText('pnpm test').length).toBeGreaterThan(0)
    const firstDuration = screen.getAllByTestId('task-timing-span-row')[0]
    expect(firstDuration).toHaveTextContent('12s')
  })

  it('hides categories without positive sampled time', async () => {
    mockGetTaskTiming.mockResolvedValue({
      ...timingResponse,
      triage: [
        { kind: 'tool', duration_ms: 0, sample_count: 1, observed: true },
        { kind: 'subagent', duration_ms: 0, sample_count: 0, observed: false },
      ],
    })
    renderPanel()

    await screen.findByTestId('task-timing-legend')
    const legendItems = screen.queryAllByTestId('task-timing-legend-item')
    expect(legendItems.find(item => item.dataset.kind === 'tool')).toBeUndefined()
    expect(legendItems.find(item => item.dataset.kind === 'subagent')).toBeUndefined()
  })

  it('shows loading, empty, and error states without inventing timing', async () => {
    const pending = new Promise<TaskTimingResponse>(() => {})
    mockGetTaskTiming.mockReturnValueOnce(pending)
    const { rerender } = renderPanel()
    expect(screen.getByTestId('task-timing-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('task-timing-attribution-bar')).not.toBeInTheDocument()

    mockGetTaskTiming.mockResolvedValueOnce(emptyResponse)
    rerender(<TaskTimingPanel panelProps={{ taskId: 43 }} onClose={jest.fn()} embedded={false} />)
    expect(await screen.findByTestId('task-timing-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('task-timing-attribution-bar')).not.toBeInTheDocument()

    mockGetTaskTiming.mockRejectedValueOnce(new Error('timing unavailable'))
    rerender(<TaskTimingPanel panelProps={{ taskId: 44 }} onClose={jest.fn()} embedded={false} />)
    expect(await screen.findByTestId('task-timing-error')).toBeInTheDocument()
    expect(screen.getByText('timing unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('task-timing-attribution-bar')).not.toBeInTheDocument()
  })

  it('retries after a timing request fails', async () => {
    const user = userEvent.setup()
    mockGetTaskTiming
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(timingResponse)
    renderPanel()

    await screen.findByTestId('task-timing-error')
    await user.click(screen.getByTestId('task-timing-retry'))

    expect(await screen.findByTestId('task-timing-attribution-bar')).toBeInTheDocument()
    expect(mockGetTaskTiming).toHaveBeenCalledTimes(2)
  })

  it('refreshes a running timing snapshot without losing panel context', async () => {
    const user = userEvent.setup()
    mockGetTaskTiming.mockResolvedValueOnce(overlappingOpenSubagentResponse).mockResolvedValueOnce({
      ...overlappingOpenSubagentResponse,
      wall_time_ms: 18_000,
      observed_ms: 13_000,
    })
    renderPanel()

    await screen.findByTestId('task-timing-refresh')
    await user.click(screen.getByTestId('task-timing-refresh'))

    expect(mockGetTaskTiming).toHaveBeenCalledTimes(2)
    expect(await screen.findByTestId('task-timing-wall-time')).toHaveTextContent('18s')
  })

  it('renders timeline spans and gaps on one wall-clock scale', async () => {
    mockGetTaskTiming.mockResolvedValue(timingResponse)
    renderPanel()

    await screen.findByTestId('task-timing-timeline-details')
    const bars = screen.getAllByTestId('task-timing-span-bar')
    expect(Number.parseFloat(bars[0].style.left)).toBeCloseTo((2 / 18) * 100, 10)
    expect(Number.parseFloat(bars[0].style.width)).toBeCloseTo((12 / 18) * 100, 10)
    expect(Number.parseFloat(bars[1].style.left)).toBeCloseTo((2 / 18) * 100, 10)
    expect(Number.parseFloat(bars[1].style.width)).toBeCloseTo((4 / 18) * 100, 10)
  })

  it('marks interior unobserved intervals on the shared timeline', async () => {
    mockGetTaskTiming.mockResolvedValue(interiorGapResponse)
    renderPanel()

    await screen.findByTestId('task-timing-timeline-details')
    const gaps = screen.getAllByTestId('task-timing-interior-gap')
    expect(gaps.length).toBeGreaterThan(0)
    const gap = gaps.find(item => item.style.left !== '0%')
    expect(gap).toBeDefined()
    if (!gap) return
    expect(Number.parseFloat(gap.style.left)).toBeCloseTo((6 / 18) * 100, 10)
    expect(Number.parseFloat(gap.style.width)).toBeCloseTo((6 / 18) * 100, 10)
  })

  it('keeps overlapping spans on parallel timeline lanes', async () => {
    mockGetTaskTiming.mockResolvedValue(parallelSubagentResponse)
    renderPanel()

    await screen.findByTestId('task-timing-timeline-details')
    const subagentTrack = screen
      .getAllByTestId('task-timing-track')
      .find(track => track.dataset.kind === 'subagent')
    expect(subagentTrack).toBeDefined()
    if (!subagentTrack) return

    const lanes = within(subagentTrack).getAllByTestId('task-timing-span-bar')
    expect(lanes).toHaveLength(2)
    expect(lanes[0].parentElement).not.toBe(lanes[1].parentElement)
    expect(Number.parseFloat(lanes[0].style.left)).toBeCloseTo((1 / 18) * 100, 10)
    expect(Number.parseFloat(lanes[1].style.left)).toBeCloseTo((2 / 18) * 100, 10)
  })

  it('keeps a later span off an open span lane', async () => {
    mockGetTaskTiming.mockResolvedValue(overlappingOpenSubagentResponse)
    renderPanel()

    await screen.findByTestId('task-timing-timeline-details')
    const subagentTrack = screen
      .getAllByTestId('task-timing-track')
      .find(track => track.dataset.kind === 'subagent')
    expect(subagentTrack).toBeDefined()
    if (!subagentTrack) return

    const bars = within(subagentTrack).getAllByTestId('task-timing-span-bar')
    expect(bars).toHaveLength(2)
    expect(bars[0].parentElement).not.toBe(bars[1].parentElement)
    expect(Number.parseFloat(bars[0].style.width)).toBeCloseTo((17 / 18) * 100, 10)
    expect(screen.getAllByTestId('task-timing-span-row')[0]).toHaveTextContent(
      'timing.spans.running'
    )
    expect(Number.parseFloat(bars[1].style.width)).toBeCloseTo((8 / 18) * 100, 10)
  })

  it('copies a Markdown report to the clipboard', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mockGetTaskTiming.mockResolvedValue(timingResponse)
    renderPanel()

    await screen.findByTestId('task-timing-copy-report')
    await act(async () => {
      screen.getByTestId('task-timing-copy-report').click()
    })

    expect(writeText).toHaveBeenCalledTimes(1)
    const report = writeText.mock.calls[0][0] as string
    expect(report).toContain('# Wegent Timing Diagnostic Report')
    expect(report).toContain('- Status: COMPLETED')
    expect(report).toContain('| agent | 8s | 47.1% | 1 | yes |')
    expect(report).not.toContain('## Top spans')
    expect(report).toContain('| 11 | agent | Agent execution | 2s → 14s |')
    expect(report).toContain('| agent-1 | executor-manager | executor |')
  })

  it('reports model-call first-token and output timing', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mockGetTaskTiming.mockResolvedValue(modelCallTimingResponse)
    renderPanel()

    await screen.findByText('Model call: model-x')

    await screen.findByTestId('task-timing-copy-report')
    await act(async () => {
      screen.getByTestId('task-timing-copy-report').click()
    })

    const report = writeText.mock.calls[0][0] as string
    expect(report).toContain('Model call: model-x · first token=2s · output=8s')
  })

  it('uses semantic theme classes and a responsive layout', async () => {
    mockGetTaskTiming.mockResolvedValue(timingResponse)
    const { container } = renderPanel()

    expect(await screen.findByTestId('task-timing-panel')).toHaveClass(
      'bg-base',
      'text-text-primary'
    )
    expect(screen.getByTestId('task-timing-attribution-bar')).toHaveClass('bg-muted')
    expect(screen.getByTestId('task-timing-span-table')).toHaveClass('overflow-x-auto')
    expect(screen.queryByTestId('task-timing-suspect-table')).not.toBeInTheDocument()
    expect(container.querySelector('.bg-muted')).toBeInTheDocument()
  })

  it('paginates span details and supports showing all rows', async () => {
    const user = userEvent.setup()
    mockGetTaskTiming.mockResolvedValue(paginatedTimingResponse)
    renderPanel()

    expect(await screen.findAllByTestId('task-timing-span-row')).toHaveLength(25)
    expect(screen.getByTestId('task-timing-span-pagination')).toHaveTextContent(
      'timing.spans.pagination_range:1,25,27'
    )
    expect(screen.queryByText('Span 26')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('task-timing-next-page'))
    expect(await screen.findAllByTestId('task-timing-span-row')).toHaveLength(2)
    expect(screen.getByText('Span 26')).toBeInTheDocument()
    expect(screen.getByText('Span 27')).toBeInTheDocument()

    await user.click(screen.getByTestId('task-timing-prev-page'))
    expect(await screen.findAllByTestId('task-timing-span-row')).toHaveLength(25)
  })

  it('keeps report-order numbering stable when sorting by duration', async () => {
    const user = userEvent.setup()
    mockGetTaskTiming.mockResolvedValue(durationSortedTimingResponse)
    renderPanel()

    expect(await screen.findAllByTestId('task-timing-span-row')).toHaveLength(2)
    expect(screen.getAllByTestId('task-timing-span-row')[0]).toHaveTextContent('2')

    await user.click(screen.getByTestId('task-timing-sort-spans'))

    expect(screen.getAllByTestId('task-timing-span-row')[0]).toHaveTextContent('2')
    expect(screen.getAllByTestId('task-timing-span-row')[1]).toHaveTextContent('1')
  })

  it('compresses waiting-user intervals in the analysis timeline', async () => {
    const user = userEvent.setup()
    mockGetTaskTiming.mockResolvedValue(waitingUserTimingResponse)
    renderPanel()

    await screen.findByTestId('task-timing-compress-waiting-user')
    const waitingTrack = screen
      .getAllByTestId('task-timing-track')
      .find(track => track.dataset.kind === 'waiting_user')
    expect(waitingTrack).toBeDefined()
    if (!waitingTrack) return

    const waitingBar = within(waitingTrack).getByTestId('task-timing-span-bar')
    expect(Number.parseFloat(waitingBar.style.width)).toBeCloseTo((183 / 197) * 100, 10)

    await user.click(screen.getByTestId('task-timing-compress-waiting-user'))

    expect(screen.getByTestId('task-timing-compressed-coverage')).toBeInTheDocument()
    expect(Number.parseFloat(waitingBar.style.width)).toBeCloseTo((1 / 101) * 100, 10)
    expect(waitingBar.style.minWidth).toBe('6px')
    expect(screen.getByText('timing.timeline.compressed_note')).toBeInTheDocument()
  })

  it('keeps waiting-user position while stretching surrounding intervals', async () => {
    const user = userEvent.setup()
    mockGetTaskTiming.mockResolvedValue(waitingUserMiddleTimingResponse)
    renderPanel()

    await screen.findByTestId('task-timing-compress-waiting-user')
    await user.click(screen.getByTestId('task-timing-compress-waiting-user'))

    const bars = screen.getAllByTestId('task-timing-span-bar')
    const beforeBar = bars.find(
      bar =>
        bar.dataset.kind === 'agent' && bar.getAttribute('aria-label')?.includes('Agent execution')
    )
    const waitingBar = bars.find(bar => bar.dataset.kind === 'waiting_user')
    const afterBar = bars.find(
      bar =>
        bar.dataset.kind === 'agent' &&
        bar.getAttribute('aria-label')?.includes('Agent after waiting')
    )
    expect(beforeBar).toBeDefined()
    expect(waitingBar).toBeDefined()
    expect(afterBar).toBeDefined()
    if (!beforeBar || !waitingBar || !afterBar) return

    expect(Number.parseFloat(beforeBar.style.left)).toBeCloseTo(0, 10)
    expect(Number.parseFloat(beforeBar.style.width)).toBeCloseTo((50 / 101) * 100, 10)
    expect(Number.parseFloat(waitingBar.style.left)).toBeCloseTo((50 / 101) * 100, 10)
    expect(Number.parseFloat(waitingBar.style.width)).toBeCloseTo((1 / 101) * 100, 10)
    expect(waitingBar.style.minWidth).toBe('6px')
    expect(Number.parseFloat(afterBar.style.left)).toBeCloseTo((51 / 101) * 100, 10)
    expect(Number.parseFloat(afterBar.style.width)).toBeCloseTo((50 / 101) * 100, 10)
  })
})
