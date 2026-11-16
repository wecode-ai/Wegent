import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createVisualizationWheelScript,
  forwardVisualizationWheel,
  withVisualizationWheel,
} from './inlineVisualizationScroll'

const TOKEN = 'visualization-scroll-token'
const MESSAGE_TYPE = 'wework-inline-visualization-wheel'

test.each([
  '<section><script>const closingTag = "</body>"</script><p>Form</p></section>',
  '<!doctype html><html><body><script>const closingTag = "</body>"</script><p>Form</p></body></html>',
])('adds the scroll bridge without rewriting app scripts or document structure', html => {
  const parsed = new DOMParser().parseFromString(withVisualizationWheel(html, TOKEN), 'text/html')
  const scripts = parsed.querySelectorAll('script')
  expect(scripts).toHaveLength(2)
  expect(scripts[0].textContent).toBe('const closingTag = "</body>"')
  expect(scripts[1].textContent).toContain("addEventListener('wheel'")
  expect(parsed.querySelector('p')?.textContent).toBe('Form')
  expect(parsed.doctype?.name).toBe(html.startsWith('<!doctype') ? 'html' : undefined)
})

function message(overrides: Record<string, unknown> = {}) {
  return {
    type: MESSAGE_TYPE,
    token: TOKEN,
    deltaX: 0,
    deltaY: 80,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  }
}

function createViewport(origin: 'top' | 'bottom', visibleWrapper = false) {
  const viewport = document.createElement('div')
  viewport.dataset.scrollOrigin = origin
  const frame = document.createElement('iframe')
  let parent: HTMLElement = viewport
  if (visibleWrapper) {
    const wrapper = document.createElement('div')
    wrapper.dataset.scrollOrigin = origin
    wrapper.className = 'overflow-visible'
    viewport.append(wrapper)
    parent = wrapper
  }
  parent.append(frame)
  document.body.append(viewport)
  viewport.scrollTop = origin === 'top' ? 400 : -400
  const scrollBy = vi.fn((options: ScrollToOptions) => {
    viewport.scrollTop += options.top ?? 0
    viewport.scrollLeft += options.left ?? 0
  })
  Object.defineProperty(viewport, 'scrollBy', { value: scrollBy })
  return { viewport, frame, scrollBy, wrapper: parent }
}

type ScrollBoxOptions = {
  height?: number
  contentHeight?: number
  top?: number
  width?: number
  contentWidth?: number
  left?: number
  reversed?: boolean
}

function mockScrollBox(element: HTMLElement, options: ScrollBoxOptions = {}) {
  const height = options.height ?? 600
  const contentHeight = options.contentHeight ?? height
  const width = options.width ?? 800
  const contentWidth = options.contentWidth ?? width
  const maximumY = Math.max(0, contentHeight - height)
  const maximumX = Math.max(0, contentWidth - width)
  let top = options.top ?? 0
  let left = options.left ?? 0
  const clamp = (position: number, maximum: number) =>
    options.reversed
      ? Math.max(-maximum, Math.min(0, position))
      : Math.max(0, Math.min(maximum, position))
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: height },
    scrollHeight: { configurable: true, value: contentHeight },
    clientWidth: { configurable: true, value: width },
    scrollWidth: { configurable: true, value: contentWidth },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = clamp(value, maximumY)
      },
    },
    scrollLeft: {
      configurable: true,
      get: () => left,
      set: (value: number) => {
        left = clamp(value, maximumX)
      },
    },
    scrollBy: {
      configurable: true,
      value: vi.fn((value: ScrollToOptions) => {
        element.scrollTop += value.top ?? 0
        element.scrollLeft += value.left ?? 0
      }),
    },
  })
}

function createChild(rootElement: 'html' | 'body' = 'html') {
  const childDocument = document.implementation.createHTMLDocument('Visualization')
  Object.defineProperty(childDocument, 'scrollingElement', {
    configurable: true,
    value: rootElement === 'body' ? childDocument.body : childDocument.documentElement,
  })
  mockScrollBox(childDocument.documentElement)
  mockScrollBox(childDocument.body)
  childDocument.documentElement.style.overscrollBehavior = 'contain'
  childDocument.documentElement.style.lineHeight = '20px'
  childDocument.body.style.lineHeight = '20px'
  const postMessage = vi.fn()
  const registerListener = vi.fn(
    (name: string, listener: EventListener, options: AddEventListenerOptions) => {
      childDocument.addEventListener(name, listener, options)
    }
  )
  new Function(
    'document',
    'parent',
    'addEventListener',
    'getComputedStyle',
    createVisualizationWheelScript(TOKEN)
  )(childDocument, { postMessage }, registerListener, getComputedStyle)

  function wheel(target: HTMLElement, options: WheelEventInit = {}) {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 100,
      ...options,
    })
    target.dispatchEvent(event)
    return event
  }

  function scrollable(options: ScrollBoxOptions = {}, parent = childDocument.body) {
    const element = childDocument.createElement('div')
    element.style.overflowX = 'auto'
    element.style.overflowY = 'auto'
    element.style.lineHeight = '20px'
    mockScrollBox(element, { height: 200, contentHeight: 500, ...options })
    parent.append(element)
    return element
  }

  return { childDocument, postMessage, registerListener, wheel, scrollable }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('forwardVisualizationWheel', () => {
  test.each(['top'] as const)(
    'records user intent before scrolling the actual %s-origin viewport',
    origin => {
      const { viewport, frame, scrollBy, wrapper } = createViewport(origin, true)
      const order: string[] = []
      viewport.addEventListener('wheel', event => {
        order.push('intent')
        expect(event.target).toBe(frame)
        expect(event).toMatchObject({ deltaX: 24, deltaY: 80, deltaMode: 0 })
        expect(viewport.scrollTop).toBe(origin === 'top' ? 400 : -400)
      })
      scrollBy.mockImplementation(options => {
        order.push('scroll')
        viewport.scrollTop += options.top ?? 0
      })

      forwardVisualizationWheel(frame, message({ deltaX: 24 }), TOKEN)

      expect(order).toEqual(['intent', 'scroll'])
      expect(scrollBy).toHaveBeenCalledExactlyOnceWith({
        top: 80,
        left: 24,
        behavior: 'instant',
      })
      expect(viewport.scrollTop).toBe(origin === 'top' ? 480 : -320)
      expect(wrapper.scrollTop).toBe(0)
    }
  )

  test('respects cancellation by a conversation wheel listener', () => {
    const { viewport, frame, scrollBy } = createViewport('top')
    viewport.addEventListener('wheel', event => event.preventDefault())

    forwardVisualizationWheel(frame, message(), TOKEN)

    expect(scrollBy).not.toHaveBeenCalled()
    expect(viewport.scrollTop).toBe(400)
  })

  test.each([
    null,
    'wheel',
    [],
    message({ type: 'another-message' }),
    message({ token: 'forged-token' }),
    message({ deltaY: Number.NaN }),
    message({ deltaX: Number.POSITIVE_INFINITY }),
    message({ deltaY: Number.NEGATIVE_INFINITY }),
    message({ deltaY: '80' }),
    message({ deltaX: null }),
    message({ ctrlKey: 'false' }),
    message({ metaKey: undefined }),
    message({ altKey: 0 }),
    message({ shiftKey: null }),
    message({ ctrlKey: true }),
    message({ metaKey: true }),
    message({ deltaX: 0, deltaY: 0 }),
  ])('rejects forged or invalid messages without dispatching: %j', value => {
    const { frame, scrollBy } = createViewport('top')
    const listener = vi.fn()
    frame.addEventListener('wheel', listener)

    forwardVisualizationWheel(frame, value, TOKEN)

    expect(listener).not.toHaveBeenCalled()
    expect(scrollBy).not.toHaveBeenCalled()
  })
})

describe('createVisualizationWheelScript', () => {
  test('registers a nonpassive bubble listener and transfers blank-document scrolling once', () => {
    const { childDocument, postMessage, registerListener, wheel } = createChild()

    const event = wheel(childDocument.body)

    expect(registerListener).toHaveBeenCalledExactlyOnceWith(
      'wheel',
      expect.any(Function),
      expect.objectContaining({ passive: false })
    )
    expect(registerListener.mock.calls[0][2].capture).not.toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(message({ deltaY: 100 }), '*')
  })

  test('retains native scrolling when an inner area can consume the complete movement', () => {
    const { postMessage, wheel, scrollable } = createChild()
    const area = scrollable({ top: 40 })

    const event = wheel(area)

    expect(event.defaultPrevented).toBe(false)
    expect(area.scrollTop).toBe(40)
    expect(area.scrollBy).not.toHaveBeenCalled()
    expect(postMessage).not.toHaveBeenCalled()
  })

  test('contains viewport chaining and transfers root overflow in a quirks-mode fragment', () => {
    const { childDocument, postMessage, wheel } = createChild('body')
    mockScrollBox(childDocument.body, { contentHeight: 620 })

    const event = wheel(childDocument.body)

    expect(event.defaultPrevented).toBe(true)
    expect(childDocument.body.scrollTop).toBe(20)
    expect(childDocument.documentElement.style.overscrollBehavior).toBe('none')
    expect(childDocument.body.style.overscrollBehavior).toBe('none')
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(message({ deltaY: 80 }), '*')
  })

  test.each([
    { top: 280, delta: 100, expectedTop: 300, remaining: 80 },
    { top: 20, delta: -100, expectedTop: 0, remaining: -80 },
  ])('transfers only the remainder at an inner boundary: %j', scenario => {
    const { postMessage, wheel, scrollable } = createChild()
    const area = scrollable({ top: scenario.top })

    const event = wheel(area, { deltaY: scenario.delta })

    expect(event.defaultPrevented).toBe(true)
    expect(area.scrollTop).toBe(scenario.expectedTop)
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      message({ deltaY: scenario.remaining }),
      '*'
    )
    expect(area.scrollTop - scenario.top + scenario.remaining).toBe(scenario.delta)
  })

  test('conserves a partial movement through multiple nested scroll areas', () => {
    const { postMessage, wheel, scrollable } = createChild()
    const outer = scrollable({ top: 270 })
    const inner = scrollable({ top: 280 }, outer)

    const event = wheel(inner)

    expect(event.defaultPrevented).toBe(true)
    expect(inner.scrollTop).toBe(300)
    expect(outer.scrollTop).toBe(300)
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(message({ deltaY: 50 }), '*')
  })

  test.each(['contain', 'none'])('respects an inner %s overscroll boundary', overscroll => {
    const { postMessage, wheel, scrollable } = createChild()
    const area = scrollable({ top: 300 })
    area.style.overscrollBehaviorY = overscroll

    const event = wheel(area)

    expect(event.defaultPrevented).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
  })

  test('retains native partial movement when the author contains its remainder', () => {
    const { postMessage, wheel, scrollable } = createChild()
    const area = scrollable({ top: 280 })
    area.style.overscrollBehaviorY = 'contain'

    const event = wheel(area)

    expect(event.defaultPrevented).toBe(false)
    expect(area.scrollBy).not.toHaveBeenCalled()
    expect(postMessage).not.toHaveBeenCalled()
  })

  test('respects a chart handler that already consumed its wheel event', () => {
    const { childDocument, postMessage, wheel } = createChild()
    const chart = childDocument.createElement('canvas')
    childDocument.body.append(chart)
    chart.addEventListener('wheel', event => event.preventDefault())

    const event = wheel(chart)

    expect(event.defaultPrevented).toBe(true)
    expect(postMessage).not.toHaveBeenCalled()
  })

  test.each(['ctrlKey', 'metaKey'] as const)('keeps the Wework %s page zoom guard', modifier => {
    const { childDocument, postMessage, wheel } = createChild()

    const event = wheel(childDocument.body, { [modifier]: true })

    expect(event.defaultPrevented).toBe(true)
    expect(postMessage).not.toHaveBeenCalled()
  })

  test.each(['number', 'select'])('preserves a focused %s control default', kind => {
    const { childDocument, postMessage, wheel } = createChild()
    const control = childDocument.createElement(kind === 'select' ? 'select' : 'input')
    if (control instanceof HTMLInputElement) control.type = 'number'
    childDocument.body.append(control)
    Object.defineProperty(childDocument, 'activeElement', { value: control })

    const event = wheel(control)

    expect(event.defaultPrevented).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
  })

  test.each([
    { mode: WheelEvent.DOM_DELTA_LINE, delta: 2, pixels: 40 },
    { mode: WheelEvent.DOM_DELTA_PAGE, delta: 1, pixels: 600 },
  ])('normalizes wheel units to CSS pixels: %j', ({ mode, delta, pixels }) => {
    const { childDocument, postMessage, wheel } = createChild()

    const event = wheel(childDocument.body, { deltaY: delta, deltaMode: mode })

    expect(event.defaultPrevented).toBe(true)
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(message({ deltaY: pixels }), '*')
  })

  test('preserves native document scrolling while the bounded frame has available content', () => {
    const { childDocument, postMessage, wheel } = createChild()
    mockScrollBox(childDocument.documentElement, { contentHeight: 1800, top: 100 })

    const event = wheel(childDocument.body)

    expect(event.defaultPrevented).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
  })

  test('normalizes horizontal page movement using the frame width', () => {
    const { childDocument, postMessage, wheel } = createChild()

    const event = wheel(childDocument.body, {
      deltaX: 1,
      deltaY: 0,
      deltaMode: WheelEvent.DOM_DELTA_PAGE,
    })

    expect(event.defaultPrevented).toBe(true)
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(message({ deltaX: 800, deltaY: 0 }), '*')
  })

  test('handles a partial column-reverse scroll without changing its origin', () => {
    const { postMessage, wheel, scrollable } = createChild()
    const area = scrollable({ top: -280, reversed: true })
    area.style.display = 'flex'
    area.style.flexDirection = 'column-reverse'

    const event = wheel(area, { deltaY: -100 })

    expect(event.defaultPrevented).toBe(true)
    expect(area.scrollTop).toBe(-300)
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(message({ deltaY: -80 }), '*')
  })

  test('preserves local horizontal consumption while transferring vertical movement', () => {
    const { postMessage, wheel, scrollable } = createChild()
    const area = scrollable({
      height: 200,
      contentHeight: 200,
      width: 200,
      contentWidth: 500,
      left: 40,
    })

    const event = wheel(area, { deltaX: 50, deltaY: 100 })

    expect(event.defaultPrevented).toBe(true)
    expect(area.scrollLeft).toBe(90)
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(message({ deltaY: 100 }), '*')
  })
})
