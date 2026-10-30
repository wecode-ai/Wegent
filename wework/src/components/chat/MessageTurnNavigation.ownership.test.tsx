import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { MessageTurnNavigation } from '@wegent/collaboration/conversation'
import {
  allResizeCallbacks,
  installScrollTestEnvironment,
  mockRect,
  mockScrollRelativeRect,
} from './scrollableMessageTestHelpers'

describe('MessageTurnNavigation ownership', () => {
  installScrollTestEnvironment()

  const latestMessage = {
    id: 'latest',
    role: 'user' as const,
    content: 'Latest',
    runtimeMessageIndex: 2,
  }
  const olderMessage = {
    id: 'older',
    role: 'user' as const,
    content: 'Older',
    runtimeMessageIndex: 0,
  }
  const turnNavigation = [
    {
      id: 'older',
      turnIndex: 0,
      messageIndex: 0,
      cursor: 'offset:0',
      promptPreview: 'Older',
      responsePreview: '',
    },
    {
      id: 'latest',
      turnIndex: 1,
      messageIndex: 2,
      cursor: 'offset:2',
      promptPreview: 'Latest',
      responsePreview: '',
    },
  ]

  function setup() {
    const scroll = document.createElement('div')
    const content = document.createElement('div')
    const interaction = document.createElement('div')
    scroll.append(content)
    document.body.append(scroll, interaction)
    Object.defineProperties(scroll, {
      scrollTop: { value: 400, writable: true, configurable: true },
      scrollHeight: { value: 1800, configurable: true },
      clientHeight: { value: 300, configurable: true },
    })
    mockRect(scroll, 0, 300)
    const appendAnchor = (id: string, top: number) => {
      const anchor = document.createElement('div')
      anchor.dataset.messageId = id
      content.append(anchor)
      mockScrollRelativeRect(anchor, scroll, top, 60)
    }
    appendAnchor('latest', 1500)
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      if (typeof top === 'number') scroll.scrollTop = top
    })
    scroll.scrollTo = scrollTo
    let resolveLoad!: () => void
    const load = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveLoad = resolve
        })
    )
    const onTarget = vi.fn()
    const onLoading = vi.fn()
    const props = {
      translate: (key: string) => key,
      turnNavigation,
      scrollRef: { current: scroll },
      contentRef: { current: content },
      interactionRef: { current: interaction },
      onLoadTurnNavigationItem: load,
      onNavigationScrollTargetChange: onTarget,
      onNavigationLoadStateChange: onLoading,
    }
    const view = render(<MessageTurnNavigation {...props} messages={[latestMessage]} />)
    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[0])
    expect(load).toHaveBeenCalledOnce()
    expect(onLoading).toHaveBeenLastCalledWith(true)
    return {
      scroll,
      content,
      interaction,
      scrollTo,
      onTarget,
      onLoading,
      async finishOlderLoad() {
        appendAnchor('older', 100)
        view.rerender(<MessageTurnNavigation {...props} messages={[olderMessage, latestMessage]} />)
        await act(async () => {
          resolveLoad()
          await Promise.resolve()
        })
      },
      cleanup() {
        view.unmount()
        scroll.remove()
        interaction.remove()
      },
    }
  }

  test('a newer marker replaces an unresolved older target', async () => {
    const fixture = setup()
    try {
      fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[1])
      expect(fixture.scroll.scrollTop).toBe(1404)
      act(() => vi.advanceTimersByTime(16))
      expect(fixture.onTarget).toHaveBeenLastCalledWith(null)
      fixture.scrollTo.mockClear()
      await fixture.finishOlderLoad()
      expect(fixture.scrollTo).not.toHaveBeenCalled()
      expect(fixture.onTarget).not.toHaveBeenCalledWith('older')
      expect(fixture.onLoading).toHaveBeenLastCalledWith(false)
    } finally {
      fixture.cleanup()
    }
  })

  test.each(['wheel', 'scrollbar'] as const)(
    '%s input cancels unresolved navigation',
    async input => {
      const fixture = setup()
      try {
        if (input === 'wheel') fireEvent.wheel(fixture.scroll, { deltaY: -100 })
        else fireEvent.pointerDown(fixture.interaction, { button: 0, buttons: 1 })
        expect(fixture.onLoading).toHaveBeenLastCalledWith(false)
        await fixture.finishOlderLoad()
        expect(fixture.scrollTo).not.toHaveBeenCalled()
        expect(fixture.onTarget).not.toHaveBeenCalledWith('older')
      } finally {
        fixture.cleanup()
      }
    }
  )

  test('scrollbar input stops the active native navigation animation', () => {
    const fixture = setup()
    try {
      fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[1])
      fixture.scrollTo.mockClear()
      fireEvent.pointerDown(fixture.interaction, { button: 0, buttons: 1 })
      expect(fixture.scrollTo).toHaveBeenLastCalledWith({ top: 1404, behavior: 'auto' })
      expect(fixture.onTarget).toHaveBeenLastCalledWith(null)
    } finally {
      fixture.cleanup()
    }
  })

  function startSmoothNavigation() {
    const fixture = setup()
    fixture.scrollTo.mockImplementation(({ top, behavior }: ScrollToOptions) => {
      if (behavior !== 'smooth') fixture.scroll.scrollTop = Number(top)
    })
    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[1])
    expect(fixture.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1404, behavior: 'smooth' })
    const notifyResize = () => {
      act(() => {
        for (const callback of [...allResizeCallbacks]) callback([], {} as ResizeObserver)
      })
    }
    return { ...fixture, notifyResize }
  }

  test('unchanged layout notifications preserve the native turn navigation animation', () => {
    const fixture = startSmoothNavigation()
    try {
      fixture.notifyResize()
      expect(fixture.scrollTo).toHaveBeenCalledTimes(1)
      fixture.scroll.scrollTop = 700
      fixture.notifyResize()
      expect(fixture.scroll.scrollTop).toBe(700)
      expect(fixture.scrollTo).toHaveBeenCalledTimes(1)
      expect(fixture.onTarget).toHaveBeenLastCalledWith('latest')
      fixture.scroll.scrollTop = 1404
      fireEvent(fixture.scroll, new Event('scrollend'))
      expect(fixture.onTarget).toHaveBeenLastCalledWith(null)
    } finally {
      fixture.cleanup()
    }
  })

  test('a changed layout retargets native turn navigation and then releases ownership', () => {
    const fixture = startSmoothNavigation()
    try {
      fixture.scroll.scrollTop = 700
      mockScrollRelativeRect(fixture.content.firstElementChild!, fixture.scroll, 1550, 60)
      fixture.notifyResize()
      expect(fixture.scrollTo).toHaveBeenCalledTimes(2)
      expect(fixture.scrollTo).toHaveBeenLastCalledWith({ top: 1454, behavior: 'auto' })
      act(() => vi.advanceTimersByTime(16))
      expect(fixture.onTarget).toHaveBeenLastCalledWith(null)
      fixture.notifyResize()
      expect(fixture.scrollTo).toHaveBeenCalledTimes(2)
    } finally {
      fixture.cleanup()
    }
  })
})
