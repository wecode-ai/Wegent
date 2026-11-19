import { afterEach, expect, test, vi } from 'vitest'
import {
  createElementFrameSampler,
  ELEMENT_METRICS_START_MARK,
  ELEMENT_METRICS_STOP_MARK,
  startElementMetricsClock,
  stopElementMetricsClock,
} from './element-frame-metrics'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('records the exact performance marker used to align native trace and RAF timestamps', () => {
  const timeline = {
    timeOrigin: 1794938438189,
    clearMarks: vi.fn(),
    mark: vi.fn(() => ({ startTime: 65.125 }) as PerformanceMark),
  }
  const clock = startElementMetricsClock(timeline)

  expect(timeline.clearMarks.mock.calls).toEqual([
    [ELEMENT_METRICS_START_MARK],
    [ELEMENT_METRICS_STOP_MARK],
  ])
  expect(timeline.mark).toHaveBeenCalledExactlyOnceWith(ELEMENT_METRICS_START_MARK)
  expect(clock).toEqual({
    timeOrigin: 1794938438189,
    startedAt: 65.125,
    firstFrameTime: null,
    stoppedAt: null,
  })
})

test('keeps the original stop marker when sampling is stopped more than once', () => {
  const clock = {
    timeOrigin: 1794938438189,
    startedAt: 65.125,
    firstFrameTime: 60,
    stoppedAt: null,
  }
  const timeline = { mark: vi.fn(() => ({ startTime: 395.25 }) as PerformanceMark) }

  stopElementMetricsClock(clock, timeline)
  stopElementMetricsClock(clock, timeline)

  expect(timeline.mark).toHaveBeenCalledExactlyOnceWith(ELEMENT_METRICS_STOP_MARK)
  expect(clock.stoppedAt).toBe(395.25)
  expect(clock.firstFrameTime).toBe(60)
})

test('retains the exact comment animation after the live style has expired', () => {
  const comment = document.createElement('article')
  comment.dataset.testid = 'comment-42'
  document.body.append(comment)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  let animationName = 'task-detail-comment-flash'
  vi.stubGlobal('getComputedStyle', () => ({ animationName }))
  comment.getAnimations = () => []
  const sample = createElementFrameSampler(document.body, '[data-testid="comment-42"]')

  const highlighted = sample()
  animationName = 'none'
  const expired = sample()

  expect(highlighted[0]).toMatchObject({ animationName: 'task-detail-comment-flash' })
  expect(expired[0]).toMatchObject({ animationName: 'none' })
})

test('does not attribute another comment animation to the requested comment', () => {
  const target = document.createElement('article')
  target.dataset.testid = 'comment-42'
  const other = document.createElement('article')
  other.dataset.testid = 'comment-43'
  document.body.append(target, other)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('getComputedStyle', (element: Element) => ({
    animationName: element === other ? 'task-detail-comment-flash' : 'none',
  }))
  target.getAnimations = () => []
  other.getAnimations = () => []

  const frames = createElementFrameSampler(document.body, '[data-testid="comment-42"]')()

  expect(frames).toHaveLength(1)
  expect(frames[0].animationName).toBe('none')
})
