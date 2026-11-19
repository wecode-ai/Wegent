// @vitest-environment jsdom
import { act, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  useDOMEvent,
  useEscapeKey,
  useIntersectionEvent,
  useFocusRequest,
  useOwnedFocusTarget,
  useAutoResizeTextarea,
  useScrollRequest,
  type DomEventOptions,
} from './dom-events'
import { ProjectChatComposerSurface } from './composer/ProjectChatComposerSurface'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
function Probe({
  listener,
  options,
  target = 'document',
}: {
  listener: (event: Event) => void
  options?: DomEventOptions
  target?: 'window' | 'document'
}) {
  useDOMEvent(target, 'native-probe', listener, options)
  return null
}

test('updated callbacks retain native listener ordering; disabling and unmounting detach them', () => {
  const calls: string[] = []
  const first = () => calls.push('first'),
    second = () => calls.push('second'),
    external = () => calls.push('external')
  act(() => root.render(<Probe listener={first} />))
  document.addEventListener('native-probe', external)
  try {
    act(() => root.render(<Probe listener={second} />))
    act(() => document.dispatchEvent(new Event('native-probe')))
    expect(calls).toEqual(['second', 'external'])
    calls.length = 0
    act(() => root.render(<Probe listener={second} options={{ enabled: false }} />))
    act(() => document.dispatchEvent(new Event('native-probe')))
    expect(calls).toEqual(['external'])
    act(() => root.render(null))
    calls.length = 0
    document.dispatchEvent(new Event('native-probe'))
    expect(calls).toEqual(['external'])
  } finally {
    document.removeEventListener('native-probe', external)
  }
})

test('native capture and stopImmediatePropagation semantics remain intact', () => {
  const calls: string[] = []
  function Capture() {
    useDOMEvent('document', 'native-probe', () => calls.push('capture'), {
      capture: true,
    })
    useDOMEvent('document', 'native-probe', () => calls.push('bubble'))
    return <button data-testid="capture-target">target</button>
  }
  act(() => root.render(<Capture />))
  const button = container.querySelector('button')!
  button.addEventListener('native-probe', () => calls.push('target'))
  act(() => button.dispatchEvent(new Event('native-probe', { bubbles: true })))
  expect(calls).toEqual(['capture', 'target', 'bubble'])
  calls.length = 0
  function Stop() {
    useDOMEvent('document', 'native-probe', event => {
      calls.push('stop')
      event.stopImmediatePropagation()
    })
    useDOMEvent('document', 'native-probe', () => calls.push('later'))
    return null
  }
  act(() => root.render(<Stop />))
  act(() => document.dispatchEvent(new Event('native-probe')))
  expect(calls).toEqual(['stop'])
})

test('once and AbortSignal are enforced by the native target', () => {
  const listener = vi.fn()
  act(() => root.render(<Probe listener={listener} options={{ once: true }} />))
  act(() => {
    document.dispatchEvent(new Event('native-probe'))
    document.dispatchEvent(new Event('native-probe'))
  })
  expect(listener).toHaveBeenCalledTimes(1)
  const controller = new window.AbortController()
  act(() => root.render(<Probe listener={listener} options={{ signal: controller.signal }} />))
  controller.abort()
  act(() => document.dispatchEvent(new Event('native-probe')))
  expect(listener).toHaveBeenCalledTimes(1)
})

test('changing event owners detaches the previous target', () => {
  const listener = vi.fn()
  act(() => root.render(<Probe listener={listener} />))
  act(() => root.render(<Probe listener={listener} target="window" />))
  act(() => document.dispatchEvent(new Event('native-probe')))
  expect(listener).not.toHaveBeenCalled()
  act(() => window.dispatchEvent(new Event('native-probe')))
  expect(listener).toHaveBeenCalledTimes(1)
})

test('composer stays expanded for internal clicks and collapses on outside clicks', () => {
  const onClickCapture = vi.fn()
  act(() =>
    root.render(
      <ProjectChatComposerSurface formProps={{ onClickCapture }} canCollapseInShortPane>
        <button type="button" data-testid="composer-action">
          Action
        </button>
      </ProjectChatComposerSurface>
    )
  )
  const form = container.querySelector('[data-testid="project-chat-composer-form"]')!
  const action = container.querySelector('[data-testid="composer-action"]')!
  act(() => action.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(form.getAttribute('data-short-expanded')).toBe('true')
  act(() => action.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(form.getAttribute('data-short-expanded')).toBe('true')
  expect(onClickCapture).toHaveBeenCalledTimes(2)
  act(() => document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(form.getAttribute('data-short-expanded')).toBe('false')
})

test('visibility sessions resolve mounted root refs and release old observers on callback changes or disabling', () => {
  const sessions: {
    callback: IntersectionObserverCallback
    options?: IntersectionObserverInit
    observe: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }[] = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        sessions.push({
          callback,
          options,
          observe: this.observe,
          disconnect: this.disconnect,
        })
      }
    }
  )
  function Visibility({
    listener,
    enabled = true,
  }: {
    listener: IntersectionObserverCallback
    enabled?: boolean
  }) {
    const owner = useRef<HTMLDivElement>(null)
    const target = useRef<HTMLSpanElement>(null)
    useIntersectionEvent(target, listener, {
      root: owner,
      enabled,
      rootMargin: '160px',
      threshold: 0.01,
    })
    return (
      <div ref={owner}>
        <span ref={target} />
      </div>
    )
  }
  try {
    const first = vi.fn(),
      second = vi.fn()
    act(() => root.render(<Visibility listener={first} />))
    expect(sessions).toHaveLength(1)
    expect(sessions[0].options).toMatchObject({
      root: container.firstElementChild,
      rootMargin: '160px',
      threshold: 0.01,
    })
    expect(sessions[0].observe).toHaveBeenCalledWith(container.querySelector('span'))
    act(() => root.render(<Visibility listener={second} />))
    expect(sessions[0].disconnect).toHaveBeenCalledTimes(1)
    const entries = [{ isIntersecting: true }] as IntersectionObserverEntry[]
    sessions[0].callback(entries, {} as IntersectionObserver)
    sessions[1].callback(entries, {} as IntersectionObserver)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    act(() => root.render(<Visibility listener={second} enabled={false} />))
    expect(sessions[1].disconnect).toHaveBeenCalledTimes(1)
    expect(sessions).toHaveLength(2)
    act(() => root.render(null))
  } finally {
    vi.unstubAllGlobals()
  }
})

test('focus requests select input text, replace pending frames and cancel on unmount', () => {
  let sequence = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback)
    return sequence
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  function Focus({ request }: { request: number }) {
    const input = useRef<HTMLInputElement>(null)
    useFocusRequest(input, request, { selectAll: true, animationFrame: true })
    return <input ref={input} defaultValue="Find this text" />
  }
  const flushFrame = () => {
    const entries = [...frames]
    frames.clear()
    act(() => entries.forEach(([, callback]) => callback(0)))
  }
  try {
    act(() => root.render(<Focus request={0} />))
    const input = container.querySelector('input')!
    expect(document.activeElement).not.toBe(input)
    flushFrame()
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    act(() => root.render(<Focus request={1} />))
    act(() => root.render(<Focus request={2} />))
    expect(frames.size).toBe(1)
    flushFrame()
    act(() => root.render(<Focus request={3} />))
    act(() => root.render(null))
    expect(frames.size).toBe(0)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('scroll requests target the selected descendant and run only when navigation changes', () => {
  const scroll = vi.fn()
  const previous = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = scroll
  function ScrollProbe({ request, label }: { request: string; label: string }) {
    const ref = useRef<HTMLDivElement>(null)
    useScrollRequest(ref, '[data-selected]', request)
    return (
      <div ref={ref}>
        <span data-selected>{label}</span>
      </div>
    )
  }
  try {
    act(() => root.render(<ScrollProbe request="one" label="initial" />))
    expect(scroll).toHaveBeenCalledTimes(1)
    act(() => root.render(<ScrollProbe request="one" label="refreshed" />))
    expect(scroll).toHaveBeenCalledTimes(1)
    act(() => root.render(<ScrollProbe request="two" label="refreshed" />))
    expect(scroll).toHaveBeenCalledTimes(2)
    expect(scroll).toHaveBeenLastCalledWith({
      block: 'nearest',
    })
  } finally {
    HTMLElement.prototype.scrollIntoView = previous
  }
})

test('focus requests select only the requested descendant and never substitute the scope', () => {
  function DescendantFocus({ selector }: { selector: string }) {
    const ref = useRef<HTMLDivElement>(null)
    useFocusRequest(ref, undefined, { selector, preventScroll: true })
    return (
      <div ref={ref} tabIndex={-1}>
        <button data-first>First</button>
        <button data-second>Second</button>
      </div>
    )
  }
  act(() => root.render(<DescendantFocus selector="[data-second]" />))
  const first = container.querySelector<HTMLButtonElement>('[data-first]')!
  const second = container.querySelector('[data-second]')!
  expect(document.activeElement).toBe(second)
  first.focus()
  act(() => root.render(<DescendantFocus selector="[data-missing]" />))
  expect(document.activeElement).toBe(first)
})

test('coalesces composer sizing to the latest content and cancels detached layout work', () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  function Composer({ value, maximum }: { value: string; maximum: number | null }) {
    const ref = useAutoResizeTextarea(value, maximum)
    return <textarea ref={ref as RefObject<HTMLTextAreaElement | null>} defaultValue={value} />
  }
  try {
    act(() => root.render(<Composer value="a" maximum={128} />))
    act(() => root.render(<Composer value="ab" maximum={128} />))
    expect(frames.size).toBe(1)
    const textarea = container.querySelector('textarea')!
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      value: 200,
    })
    act(() => {
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach(callback => callback(0))
    })
    expect(textarea.style.height).toBe('128px')
    act(() => root.render(<Composer value="ab" maximum={null} />))
    act(() => {
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach(callback => callback(0))
    })
    expect(textarea.style.height).toBe('')
    expect(textarea.style.maxHeight).toBe('')
    act(() => root.render(<Composer value="abc" maximum={128} />))
    expect(frames.size).toBe(1)
    act(() => root.render(null))
    expect(frames.size).toBe(0)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('Escape stays with a focused portal even when its parent registers last', () => {
  const parentClose = vi.fn(),
    childClose = vi.fn()
  function Child() {
    const ref = useRef<HTMLDivElement>(null)
    const button = useRef<HTMLButtonElement>(null)
    useEscapeKey(childClose, true, ref)
    useFocusRequest(button)
    return createPortal(
      <div ref={ref}>
        <button ref={button}>Portal action</button>
      </div>,
      document.body
    )
  }
  function Parent() {
    const ref = useRef<HTMLDivElement>(null)
    useEscapeKey(parentClose, true, ref)
    return (
      <div ref={ref}>
        <Child />
      </div>
    )
  }
  act(() => root.render(<Parent />))
  act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
    )
  )
  expect(childClose).toHaveBeenCalledOnce()
  expect(parentClose).not.toHaveBeenCalled()
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
    )
  )
  expect(childClose).toHaveBeenCalledTimes(2)
  expect(parentClose).not.toHaveBeenCalled()
})

test('visibility margins measure the mounted root before creating the native observer', () => {
  let observed: IntersectionObserverInit | undefined
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(_callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
        observed = options
      }
      observe() {}
      disconnect() {}
    }
  )
  const margin = vi.fn(
    (owner: Element | Document | null) =>
      (owner instanceof Element ? owner.clientHeight : 0) + 'px 0px 0px'
  )
  const listener = vi.fn()
  function Visibility() {
    const owner = useRef<HTMLDivElement>(null)
    const target = useRef<HTMLSpanElement>(null)
    useIntersectionEvent(target, listener, { root: owner, rootMargin: margin })
    return (
      <div
        ref={node => {
          owner.current = node
          if (node) Object.defineProperty(node, 'clientHeight', { value: 1200 })
        }}
      >
        <span ref={target} />
      </div>
    )
  }
  try {
    act(() => root.render(<Visibility />))
    expect(margin).toHaveBeenCalledExactlyOnceWith(container.firstElementChild)
    expect(observed).toMatchObject({
      root: container.firstElementChild,
      rootMargin: '1200px 0px 0px',
    })
  } finally {
    vi.unstubAllGlobals()
  }
})

function OwnedFocusProbe({
  selector,
  enabled = true,
}: {
  selector?: string | null
  enabled?: boolean
}) {
  const ref = useRef<HTMLElement>(null)
  useOwnedFocusTarget(ref, selector, enabled)
  return <section ref={ref} tabIndex={-1} />
}

test('owned focus resolves a late editable target and detaches DOM observation on unmount', async () => {
  act(() => root.render(<OwnedFocusProbe selector="input" />))
  const section = container.querySelector('section')!
  act(() => section.focus())
  const input = document.createElement('input')
  await act(async () => {
    section.append(input)
  })
  expect(document.activeElement).toBe(input)
  act(() => root.render(null))
  const late = document.createElement('input')
  const focus = vi.spyOn(late, 'focus')
  await act(async () => {
    section.replaceChildren(late)
  })
  expect(focus).not.toHaveBeenCalled()
})

test('owned focus remembers controls before a target request and preserves another deliberate focus', async () => {
  act(() => root.render(<OwnedFocusProbe />))
  const section = container.querySelector('section')!
  const initial = document.createElement('input')
  initial.addEventListener('focusin', event => event.stopPropagation())
  section.append(initial)
  act(() => initial.focus())
  const next = document.createElement('button')
  section.replaceChildren(next)
  await act(async () => root.render(<OwnedFocusProbe selector="button" />))
  expect(document.activeElement).toBe(next)
  const outside = document.createElement('button')
  document.body.append(outside)
  try {
    act(() => outside.focus())
    const replacement = document.createElement('button')
    await act(async () => section.replaceChildren(replacement))
    expect(document.activeElement).toBe(outside)
    await act(async () => root.render(<OwnedFocusProbe selector="button" enabled={false} />))
    act(() => section.focus())
    await act(async () => section.replaceChildren(document.createElement('button')))
    expect(document.activeElement).toBe(section)
  } finally {
    outside.remove()
  }
})

test('deferred scroll requests cancel superseded and detached navigation frames', () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
    frames.delete(id)
  })
  const scroll = vi.fn(),
    previous = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = scroll
  function DeferredScroll({ request }: { request: { path: string } }) {
    const ref = useRef<HTMLDivElement>(null)
    useScrollRequest(ref, '[data-destination]', request, {
      animationFrame: true,
      block: 'start',
      behavior: 'instant',
    })
    return (
      <div ref={ref}>
        <span data-destination>{request.path}</span>
      </div>
    )
  }
  try {
    act(() => root.render(<DeferredScroll request={{ path: 'old' }} />))
    const oldFrame = nextFrame
    act(() => root.render(<DeferredScroll request={{ path: 'current' }} />))
    expect(cancelFrame).toHaveBeenCalledWith(oldFrame)
    expect(frames.size).toBe(1)
    for (const [id, callback] of [...frames]) {
      frames.delete(id)
      act(() => callback(0))
    }
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll.mock.contexts[0].textContent).toBe('current')
    expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' })
    act(() => root.render(<DeferredScroll request={{ path: 'removed' }} />))
    act(() => root.render(null))
    expect(frames.size).toBe(0)
    expect(scroll).toHaveBeenCalledTimes(1)
  } finally {
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
    HTMLElement.prototype.scrollIntoView = previous
  }
})
