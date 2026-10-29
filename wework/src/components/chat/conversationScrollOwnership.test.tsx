import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import { useConversationScrollController } from '../../../../packages/collaboration/src/conversation/useConversationScrollController'
import type { ConversationVirtualizer } from '../../../../packages/collaboration/src/conversation/useConversationVirtualizer'
import type { WorkbenchMessage } from '@/types/workbench'
import { getConversationScrollSnapshot } from '@/features/workbench/runtimeConversationCache'

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => false,
}))

afterEach(() => vi.restoreAllMocks())
const messages: WorkbenchMessage[] = [
  {
    id: 'before',
    role: 'user',
    content: 'Before gap',
    status: 'done',
    createdAt: '',
    runtimeMessageIndex: 0,
  },
  {
    id: 'after',
    role: 'assistant',
    content: 'After gap',
    status: 'done',
    createdAt: '',
    runtimeMessageIndex: 2,
  },
]

test.each(['pointer', 'touch'] as const)(
  'a transcript %s tap cannot turn a later streaming follow step into reader input',
  input => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const viewport = document.createElement('div')
    let height = 1000
    Object.defineProperties(viewport, {
      clientHeight: { value: 200 },
      scrollHeight: { get: () => height },
    })
    const key = `transcript-tap-${input}`
    const hook = renderHook(() =>
      useConversationScrollController({
        messages: messages.map(message => ({ ...message, status: 'streaming' as const })),
        externalScrollRef: { current: viewport },
        conversationKey: key,
      })
    )
    try {
      viewport.scrollTop = 800
      if (input === 'pointer') {
        fireEvent.pointerDown(viewport)
        fireEvent.pointerUp(viewport)
      } else {
        fireEvent.touchStart(viewport)
        fireEvent.touchEnd(viewport)
      }
      height = 1600
      act(() => hook.result.current.handleContentLayoutChange())
      // Native delivery of an intermediate spring step, still far from the growing end.
      viewport.scrollTop = 900
      fireEvent.scroll(viewport)
      fireEvent(viewport, new Event('scrollend'))
      expect(getConversationScrollSnapshot(key)?.pinnedToBottom).toBe(true)
    } finally {
      hook.unmount()
    }
  }
)

test('native touch movement pauses follow and resumes it on returning to the end', () => {
  const viewport = document.createElement('div')
  Object.defineProperties(viewport, {
    clientHeight: { value: 200 },
    scrollHeight: { value: 1000 },
  })
  viewport.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    viewport.scrollTop = Number(top)
  })
  const key = 'touch-movement-owner'
  const hook = renderHook(() =>
    useConversationScrollController({
      messages,
      externalScrollRef: { current: viewport },
      conversationKey: key,
    })
  )
  try {
    fireEvent.touchStart(viewport)
    fireEvent.touchMove(viewport)
    viewport.scrollTop = 400
    fireEvent.scroll(viewport)
    act(() => hook.result.current.handleContentLayoutChange())
    expect(viewport.scrollTop).toBe(400)
    expect(getConversationScrollSnapshot(key)?.pinnedToBottom).toBe(false)
    fireEvent.touchMove(viewport)
    viewport.scrollTop = 800
    fireEvent.scroll(viewport)
    expect(getConversationScrollSnapshot(key)?.pinnedToBottom).toBe(true)
  } finally {
    hook.unmount()
  }
})

test('a stale gap request cannot clear a new request after switching away and back', async () => {
  const resolve: Array<() => void> = []
  const load = vi.fn(() => new Promise<void>(done => resolve.push(done)))
  const { rerender } = render(
    <ScrollableMessageArea conversationKey="gap-a" messages={messages} onLoadTranscriptGap={load} />
  )
  const button = () => screen.getByTestId('runtime-transcript-gap-marker').querySelector('button')!
  fireEvent.click(button())
  rerender(
    <ScrollableMessageArea conversationKey="gap-b" messages={messages} onLoadTranscriptGap={load} />
  )
  rerender(
    <ScrollableMessageArea conversationKey="gap-a" messages={messages} onLoadTranscriptGap={load} />
  )
  fireEvent.click(button())
  expect(load).toHaveBeenCalledTimes(2)
  await act(async () => resolve[0]())
  expect(button()).toBeDisabled()
  await act(async () => resolve[1]())
  expect(button()).toBeEnabled()
})

test('bottom-button motion owns all layout growth until canceled by reader input', () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  const viewport = document.createElement('div')
  Object.defineProperties(viewport, {
    clientHeight: { value: 200 },
    scrollHeight: { value: 1000 },
  })
  viewport.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    viewport.scrollTop = Number(top)
  })
  const ref = { current: viewport }
  const hook = renderHook(() =>
    useConversationScrollController({
      messages,
      externalScrollRef: ref,
      conversationKey: 'motion-owner',
    })
  )
  const engine = {
    options: { followOnAppend: 'auto', scrollEndThreshold: 8 },
    cancelScroll: vi.fn(),
    setOptions: vi.fn(function (this: ConversationVirtualizer, options) {
      this.options = options
    }),
    scrollToOffset: vi.fn(),
  } as unknown as ConversationVirtualizer
  hook.result.current.virtualizerRef.current = engine
  viewport.scrollTop = 100
  act(() => hook.result.current.handleScrollToBottom())
  expect(hook.result.current.virtualAnchorToEnd).toBe(false)
  expect(engine.options).toMatchObject({ followOnAppend: false, scrollEndThreshold: -1 })
  act(() => hook.result.current.handleContentLayoutChange())
  expect(hook.result.current.virtualAnchorToEnd).toBe(false)
  expect(engine.scrollToOffset).not.toHaveBeenCalled()
  fireEvent.wheel(viewport, { deltaY: -3 })
  expect(engine.cancelScroll).toHaveBeenCalled()
  expect(hook.result.current.virtualScrollAdjustmentEnabled).toBe(true)
  hook.unmount()
})

test.each(['viewport', 'scrollbar'] as const)(
  'End on the %s follows the actual end when measurement changes before scroll delivery',
  target => {
    const viewport = document.createElement('div')
    const interaction = document.createElement('div')
    let height = 1000
    Object.defineProperties(viewport, {
      clientHeight: { value: 200 },
      scrollHeight: { get: () => height },
    })
    viewport.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      viewport.scrollTop = Number(top)
    })
    const hook = renderHook(() =>
      useConversationScrollController({
        messages,
        externalScrollRef: { current: viewport },
        externalScrollInteractionRef: { current: interaction },
        conversationKey: `keyboard-end-${target}`,
      })
    )
    try {
      fireEvent.wheel(viewport, { deltaY: -100 })
      viewport.scrollTop = 100
      fireEvent.scroll(viewport)
      fireEvent(viewport, new Event('scrollend'))
      fireEvent.keyDown(target === 'viewport' ? viewport : interaction, { key: 'End' })
      viewport.scrollTop = 800
      height = 1600
      // A native scroll can arrive before ResizeObserver reports the new row sizes.
      fireEvent.scroll(viewport)
      act(() => hook.result.current.handleContentLayoutChange())
      expect(viewport.scrollTop).toBe(1400)
      height = 1800
      act(() => hook.result.current.handleContentLayoutChange())
      expect(viewport.scrollTop).toBe(1600)
      fireEvent.keyDown(target === 'viewport' ? viewport : interaction, { key: 'Home' })
      viewport.scrollTop = 0
      fireEvent.scroll(viewport)
      height = 2000
      act(() => hook.result.current.handleContentLayoutChange())
      expect(viewport.scrollTop).toBe(0)
    } finally {
      hook.unmount()
    }
  }
)

test('scrollbar drag owns layout changes and returns to text anchoring after release', () => {
  const viewport = document.createElement('div')
  const content = document.createElement('div')
  const interaction = document.createElement('div')
  content.innerHTML =
    '<article data-message-id="before"><p data-scroll-anchor>Before gap</p></article>'
  viewport.append(content)
  document.body.append(viewport, interaction)
  Object.defineProperties(viewport, {
    clientHeight: { value: 200 },
    clientWidth: { value: 800 },
    scrollHeight: { value: 1000 },
  })
  viewport.scrollTop = 100
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 200)
  let contentTop = 150
  content.querySelector('p')!.getBoundingClientRect = () =>
    new DOMRect(0, contentTop - viewport.scrollTop, 600, 24)
  const hook = renderHook(() =>
    useConversationScrollController({
      messages,
      externalScrollRef: { current: viewport },
      externalScrollInteractionRef: { current: interaction },
      conversationKey: 'drag-owner',
    })
  )
  hook.result.current.contentRef.current = content
  const engine = {
    options: { anchorTo: 'end', followOnAppend: 'auto', scrollEndThreshold: 8 },
    cancelScroll: vi.fn(),
    setOptions: vi.fn(function (this: ConversationVirtualizer, options) {
      this.options = options
    }),
  } as unknown as ConversationVirtualizer
  hook.result.current.virtualizerRef.current = engine
  try {
    viewport.scrollTop = 100
    fireEvent.wheel(viewport, { deltaY: -1 })
    fireEvent.pointerDown(interaction, { button: 0, buttons: 1 })
    expect(hook.result.current.virtualAnchor).toBe('start')
    expect(hook.result.current.virtualScrollAdjustmentEnabled).toBe(false)
    expect(engine.options).toMatchObject({
      anchorTo: 'start',
      followOnAppend: false,
      scrollEndThreshold: -1,
    })
    expect(engine.shouldAdjustScrollPositionOnItemSizeChange).toBeTypeOf('function')
    contentTop += 100
    act(() => hook.result.current.handleContentLayoutChange())
    expect(viewport.scrollTop).toBe(100)
    viewport.scrollTop = 200
    fireEvent.scroll(viewport)
    fireEvent.pointerUp(interaction, { button: 0 })
    expect(hook.result.current.virtualAnchor).toBe('end')
    expect(hook.result.current.virtualScrollAdjustmentEnabled).toBe(true)
    expect(engine.shouldAdjustScrollPositionOnItemSizeChange).toBeUndefined()
    contentTop += 30
    act(() => hook.result.current.handleContentLayoutChange())
    expect(viewport.scrollTop).toBe(230)
  } finally {
    hook.unmount()
    viewport.remove()
    interaction.remove()
  }
})

test.each(['wheel', 'scrollbar'] as const)(
  'a completed navigation cannot take ownership back from %s input',
  input => {
    const viewport = document.createElement('div')
    const interaction = document.createElement('div')
    Object.defineProperties(viewport, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 1000 },
    })
    viewport.scrollTop = 800
    const hook = renderHook(() =>
      useConversationScrollController({
        messages,
        externalScrollRef: { current: viewport },
        externalScrollInteractionRef: { current: interaction },
        conversationKey: `navigation-interrupted-${input}`,
      })
    )
    act(() => hook.result.current.handleTurnNavigationScrollTargetChange('target'))
    if (input === 'wheel') fireEvent.wheel(viewport, { deltaY: -1 })
    else fireEvent.pointerDown(interaction, { button: 0, buttons: 1 })
    act(() => hook.result.current.handleTurnNavigationScrollTargetChange(null))
    expect(hook.result.current.virtualAnchorToEnd).toBe(false)
    expect(hook.result.current.virtualScrollAdjustmentEnabled).toBe(input === 'wheel')
    expect(hook.result.current.virtualAnchor).toBe(input === 'wheel' ? 'end' : 'start')
    hook.unmount()
  }
)
