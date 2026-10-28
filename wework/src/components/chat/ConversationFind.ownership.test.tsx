import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useConversationSearchTarget } from '../../../../packages/collaboration/src/conversation/useConversationSearchTarget'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function fixture() {
  let nextFrame = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id))
  const frame = () => {
    const pending = [...frames.values()]
    frames.clear()
    act(() => pending.forEach(callback => callback(performance.now())))
  }
  const scroller = document.createElement('div')
  const interaction = document.createElement('div')
  scroller.scrollTop = 500
  Object.defineProperties(scroller, {
    scrollHeight: { value: 2000 },
    clientHeight: { value: 300 },
  })
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 300)
  // Native smooth scrolling starts asynchronously and does not set scrollTop in this call.
  scroller.scrollTo = vi.fn(({ top, behavior }: ScrollToOptions) => {
    if (behavior !== 'smooth') scroller.scrollTop = Number(top)
  })
  const content = document.createElement('div')
  content.innerHTML =
    '<article data-message-id="target"><div data-testid="assistant-message-content"><p>keyword</p></div></article>'
  const createRange = document.createRange.bind(document)
  const walk = vi.spyOn(document, 'createTreeWalker')
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange()
    range.getBoundingClientRect = () => new DOMRect(0, 200, 100, 20)
    return range
  })
  const navigation = vi.fn()
  const props = {
    target: {
      query: 'keyword',
      messageId: 'target',
      occurrence: 0,
      matchCounts: new Map([['target', 1]]),
    },
    navigationPaused: false,
    contentRef: { current: content },
    scrollRef: { current: scroller },
    interactionRef: { current: interaction },
    onNavigationTargetChange: navigation,
  }
  const hook = renderHook(props => useConversationSearchTarget(props), { initialProps: props })
  for (let index = 0; index < 5; index += 1) frame()
  expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 560, behavior: 'smooth' })
  return { ...hook, props, scroller, content, interaction, navigation, frame, walk }
}

test('retains search navigation ownership until the native smooth scroll ends', () => {
  const current = fixture()
  expect(current.navigation).toHaveBeenLastCalledWith('target')
  current.scroller.scrollTop = 560
  fireEvent.scroll(current.scroller)
  expect(current.navigation).toHaveBeenLastCalledWith('target')
  fireEvent(current.scroller, new Event('scrollend'))
  expect(current.navigation).toHaveBeenLastCalledWith(null)
})

test.each(['wheel', 'scrollbar', 'pause', 'replace', 'unmount'] as const)(
  '%s cancels the pending native search animation at its current position',
  reason => {
    const current = fixture()
    current.scroller.scrollTop = 525
    if (reason === 'wheel') fireEvent.wheel(current.scroller, { deltaY: -10 })
    else if (reason === 'scrollbar') fireEvent.pointerDown(current.interaction)
    else if (reason === 'pause') current.rerender({ ...current.props, navigationPaused: true })
    else if (reason === 'replace')
      current.rerender({
        ...current.props,
        target: { ...current.props.target, query: 'another' },
      })
    else current.unmount()
    expect(current.scroller.scrollTo).toHaveBeenLastCalledWith({ top: 525, behavior: 'auto' })
    current.frame()
    expect(current.scroller.scrollTop).toBe(525)
  }
)

test('continues refreshing search highlights after manual input cancels navigation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const current = fixture()
  const scans = current.walk.mock.calls.length
  fireEvent.wheel(current.scroller, { deltaY: -10 })
  await act(async () => {
    current.content.querySelector('p')!.textContent = 'keyword updated'
    await Promise.resolve()
  })
  act(() => vi.advanceTimersByTime(80))
  current.frame()
  expect(current.walk.mock.calls.length).toBeGreaterThan(scans)
  expect(current.navigation).toHaveBeenLastCalledWith(null)
})
