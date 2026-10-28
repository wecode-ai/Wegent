import { afterEach, expect, test, vi } from 'vitest'
import { createElementFrameSampler } from './element-frame-metrics'

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
