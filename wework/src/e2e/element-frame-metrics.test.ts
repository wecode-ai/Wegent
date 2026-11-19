import { afterEach, expect, test, vi } from 'vitest'
import { createElementFrameSampler, readDrawerTrackState } from './element-frame-metrics'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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

test('reads pre-click dismissal intent without observing layout or animations', () => {
  const track = document.createElement('div')
  track.dataset.dismissing = 'false'
  track.dataset.hasConversation = 'false'
  document.body.append(track)
  const readStyle = vi.fn()
  vi.stubGlobal('getComputedStyle', readStyle)
  const readAnimations = vi.fn(() => [])
  track.getAnimations = readAnimations
  const readRect = vi.spyOn(track, 'getBoundingClientRect')

  expect(readDrawerTrackState(track)).toEqual({
    trackConnected: true,
    trackDismissing: 'false',
    trackHasConversation: 'false',
    trackInert: false,
  })
  expect(readStyle).not.toHaveBeenCalled()
  expect(readAnimations).not.toHaveBeenCalled()
  expect(readRect).not.toHaveBeenCalled()
})

test.each(['running', 'paused', 'finished'] as const)(
  'captures drawer dismissal and the %s transition without changing it',
  state => {
    const backdrop = document.createElement('div')
    const track = document.createElement('div')
    track.className = 'issue-conversation-drawers'
    track.dataset.dismissing = 'true'
    track.dataset.hasConversation = 'false'
    track.setAttribute('inert', '')
    backdrop.append(track)
    document.body.append(backdrop)
    const animation = {
      currentTime: 120,
      playState: state,
      pending: state === 'running',
      playbackRate: state === 'paused' ? 0 : 1,
      timeline: { currentTime: state === 'paused' ? null : 300 },
      cancel: vi.fn(),
      finish: vi.fn(),
    }
    track.getAnimations = vi.fn(() => [animation] as unknown as Animation[])
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.stubGlobal('getComputedStyle', () => ({
      animationName: 'none',
      transform: 'matrix(1, 0, 0, 1, 560, 0)',
      transition: 'transform 0.22s',
    }))

    const [frame] = createElementFrameSampler(backdrop, '.issue-conversation-drawers')()

    expect(frame).toMatchObject({
      trackDismissing: 'true',
      trackHasConversation: 'false',
      trackInert: true,
      trackTransform: 'matrix(1, 0, 0, 1, 560, 0)',
      trackAnimations: [
        {
          time: 120,
          state,
          pending: state === 'running',
          playbackRate: state === 'paused' ? 0 : 1,
          timelineActive: state !== 'paused',
        },
      ],
    })
    expect(animation.cancel).not.toHaveBeenCalled()
    expect(animation.finish).not.toHaveBeenCalled()
  }
)
