// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeComposerScrollFade } from './composerScrollFade'

describe('composer scroll fade', () => {
  let viewport: HTMLDivElement
  let content: HTMLDivElement
  let notifyResize: () => void
  let stop: () => void
  let height: number
  let scrollHeight: number
  const observe = vi.fn()
  const disconnect = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    height = 100
    scrollHeight = 400
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notifyResize = callback
        }
        observe = observe
        disconnect = disconnect
      }
    )
    viewport = document.createElement('div')
    content = document.createElement('div')
    viewport.append(content)
    document.body.append(viewport)
    Object.defineProperties(viewport, {
      clientHeight: { get: () => height },
      scrollHeight: { get: () => scrollHeight },
    })
    stop = observeComposerScrollFade(viewport, content)
  })

  afterEach(() => {
    stop()
    viewport.remove()
    vi.unstubAllGlobals()
  })

  function expectFade(top: number, bottom: number) {
    expect(viewport.style.getPropertyValue('--composer-scroll-fade-top')).toBe(`${top}px`)
    expect(viewport.style.getPropertyValue('--composer-scroll-fade-bottom')).toBe(`${bottom}px`)
  }

  function scrollTo(top: number) {
    viewport.scrollTop = top
    viewport.dispatchEvent(new Event('scroll'))
  }

  it('fades only toward hidden content and limits the fade to the hidden distance', () => {
    expect(observe.mock.calls.map(([target]) => target)).toEqual([viewport, content])
    expect(viewport.hasAttribute('data-composer-scroll-overflow')).toBe(true)
    expectFade(0, 16)
    scrollTo(8)
    expectFade(8, 16)
    scrollTo(290)
    expectFade(16, 10)
    scrollTo(300)
    expectFade(16, 0)
  })

  it('removes the mask after clearing a scrolled draft without needing a scroll event', () => {
    scrollTo(300)
    scrollHeight = height
    // The browser clamps scrolling to zero when the content no longer overflows.
    viewport.scrollTop = 0
    notifyResize()
    expect(viewport.hasAttribute('data-composer-scroll-overflow')).toBe(false)
    expectFade(0, 0)
    notifyResize()
    expectFade(0, 0)
  })

  it('refreshes when the viewport resizes and when content grows again', () => {
    scrollTo(300)
    height = 400
    notifyResize()
    expect(viewport.hasAttribute('data-composer-scroll-overflow')).toBe(false)
    expectFade(0, 0)
    viewport.scrollTop = 0
    scrollHeight = 800
    notifyResize()
    expect(viewport.hasAttribute('data-composer-scroll-overflow')).toBe(true)
    expectFade(0, 16)
  })

  it('keeps fitting, rounding overflow and hidden viewports unmasked', () => {
    scrollHeight = 101
    notifyResize()
    expect(viewport.hasAttribute('data-composer-scroll-overflow')).toBe(false)
    expectFade(0, 0)
    height = 0
    notifyResize()
    expect(viewport.hasAttribute('data-composer-scroll-overflow')).toBe(false)
    expectFade(0, 0)
  })

  it('clamps overscroll and releases its observer, listener and mask on disposal', () => {
    scrollTo(-10)
    expectFade(0, 16)
    scrollTo(320)
    expectFade(16, 0)
    stop()
    stop = () => {}
    expect(disconnect).toHaveBeenCalledOnce()
    expect(viewport.hasAttribute('data-composer-scroll-overflow')).toBe(false)
    scrollTo(20)
    expect(viewport.style.getPropertyValue('--composer-scroll-fade-top')).toBe('')
    expect(viewport.style.getPropertyValue('--composer-scroll-fade-bottom')).toBe('')
  })
})
