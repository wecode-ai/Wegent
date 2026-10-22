import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WindowedMarkdownChunk } from '../../../../packages/collaboration/src/markdown/WindowedMarkdownChunk'
import * as conversationDiagnostics from '../../../../packages/collaboration/src/conversation/conversationDiagnostics'
import {
  createMarkdownWindowingScope,
  MarkdownWindowingContext,
} from '../../../../packages/collaboration/src/markdown/MarkdownWindowingScope'

function rect(top: number, width: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: width,
    x: 0,
    y: top,
    width,
    height,
    toJSON() {},
  }
}

function viewportHarness(top = 4_000, richHeight = 2_407) {
  const root = document.createElement('div')
  root.dataset.scrollOrigin = 'bottom'
  document.body.append(root)
  const geometry = { top, width: 736, richHeight, rootWidth: 1_200 }
  const intersections: Array<{
    callback: IntersectionObserverCallback
    options?: IntersectionObserverInit
    target?: Element
  }> = []
  const resizes: Array<ResizeObserverCallback> = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      entry = {
        callback: (() => {}) as IntersectionObserverCallback,
      } as (typeof intersections)[number]
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.entry = { callback, options }
        intersections.push(this.entry)
      }
      observe(target: Element) {
        this.entry.target = target
      }
      disconnect() {}
    }
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resizes.push(callback)
      }
      observe() {}
      disconnect() {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this === root) return rect(76, geometry.rootWidth, geometry.rootWidth ? 791 : 0)
    if (this.hasAttribute('data-markdown-window-chunk')) {
      return rect(
        geometry.top,
        geometry.width,
        this.querySelector('[data-markdown-window-placeholder]')
          ? Number.parseFloat(this.style.minHeight) || 120
          : geometry.richHeight
      )
    }
    return rect(0, 0, 0)
  })
  const onChunkLayout = vi.fn()
  const scope = createMarkdownWindowingScope({ current: root }, onChunkLayout)
  const mount = (content = 'A bounded finished Markdown chunk.', eager = false) =>
    render(
      <MarkdownWindowingContext.Provider value={scope}>
        <WindowedMarkdownChunk content={content} chunkIndex={0} eager={eager}>
          <p data-rich-markdown>Complete Markdown</p>
        </WindowedMarkdownChunk>
      </MarkdownWindowingContext.Provider>
    )
  const notify = (isIntersecting: boolean) =>
    act(() => {
      const entry = intersections.at(-1)!
      entry.callback(
        [
          {
            target: entry.target,
            isIntersecting,
            intersectionRatio: isIntersecting ? 1 : 0,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver
      )
    })
  return { root, geometry, intersections, resizes, onChunkLayout, scope, mount, notify }
}

describe('Markdown viewport windowing', () => {
  beforeEach(() => conversationDiagnostics.resetConversationDiagnosticsForTest())
  afterEach(() => {
    document.querySelectorAll('[data-scroll-origin]').forEach(element => element.remove())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test('preserves rich layout without computing or recording diagnostic details outside capture', () => {
    const context = vi.spyOn(conversationDiagnostics, 'getConversationDiagnosticContext')
    const record = vi.spyOn(conversationDiagnostics, 'recordConversationDiagnostic')
    const harness = viewportHarness(100)
    const content = 'A finished chunk with private content.\nAnother line.'
    const view = harness.mount(content)

    expect(view.container.querySelector('[data-rich-markdown]')).not.toBeNull()
    expect(harness.onChunkLayout).toHaveBeenCalled()
    expect(harness.scope.getHeight(content, 736)).toBe(2_407)
    harness.notify(true)
    view.unmount()

    expect(context).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
    expect(conversationDiagnostics.getConversationDiagnosticsSnapshot()).toBeNull()
  })

  test('records rich dimensions and numeric metadata while capture is enabled', () => {
    conversationDiagnostics.startConversationDiagnosticCapture()
    const context = vi.spyOn(conversationDiagnostics, 'getConversationDiagnosticContext')
    const record = vi.spyOn(conversationDiagnostics, 'recordConversationDiagnostic')
    const harness = viewportHarness(100)
    const content = 'A finished chunk with private content.\nAnother line.'
    const view = harness.mount(content)
    const chunk = view.container.querySelector('[data-markdown-window-chunk]')!

    expect(context).toHaveBeenCalledWith(chunk)
    expect(record).toHaveBeenCalledWith(
      'markdown-layout',
      expect.objectContaining({
        chunkIndex: 0,
        contentLength: content.length,
        lineCount: 2,
        rendered: true,
        height: 2_407,
        width: 736,
      })
    )
    const layout = conversationDiagnostics
      .getConversationDiagnosticsSnapshot()!
      .events.filter(event => event.name === 'markdown-layout')
      .at(-1)!
    expect(layout.details).toMatchObject({ rendered: true, height: 2_407, lineCount: 2 })
    expect(JSON.stringify(layout)).not.toContain(content)
    expect(harness.onChunkLayout).toHaveBeenCalled()
    view.unmount()
    expect(record).toHaveBeenCalledWith('markdown-unmounted', expect.any(Object))
  })

  test('correlates the first intersection when capture starts after a far lazy chunk mounts', () => {
    const harness = viewportHarness()
    const content = 'A private finished chunk.\nAnother line.'
    const view = harness.mount(content)
    view.container.dataset.index = '7'
    harness.root.append(view.container)
    expect(view.container.querySelector('[data-markdown-window-placeholder]')).not.toBeNull()
    expect(conversationDiagnostics.getConversationDiagnosticsSnapshot()).toBeNull()

    conversationDiagnostics.startConversationDiagnosticCapture()
    harness.notify(false)

    const intersection = conversationDiagnostics.getConversationDiagnosticsSnapshot()!.events[0]
    expect(intersection.name).toBe('markdown-intersection')
    expect(intersection.details).toMatchObject({
      scrollerId: expect.any(Number),
      rowIndex: 7,
      chunkIndex: 0,
      contentLength: content.length,
      eager: false,
      rendered: false,
      nearViewport: false,
      lineCount: 2,
      height: 120,
      width: 736,
    })
    expect(intersection.details.scrollerId).toBeGreaterThan(0)
    expect(JSON.stringify(intersection)).not.toContain(content)
    expect(view.container.querySelector('[data-markdown-window-placeholder]')).not.toBeNull()
    view.unmount()
  })

  test.each([100, -1_400, 2_000])(
    'renders a newly mounted near chunk before asynchronous intersection delivery (top %s)',
    top => {
      const harness = viewportHarness(top)
      const view = harness.mount()
      expect(view.container.querySelector('[data-markdown-window-placeholder]')).toBeNull()
      expect(view.container.querySelector('[data-rich-markdown]')).not.toBeNull()
      expect(harness.onChunkLayout).toHaveBeenCalled()
      expect(harness.intersections[0].options).toEqual({
        root: harness.root,
        rootMargin: '1600px 0px',
      })
    }
  )

  test('keeps far chunks lazy and activates an already mounted chunk on a rapid viewport jump', () => {
    const harness = viewportHarness()
    const view = harness.mount()
    expect(view.container.querySelector('[data-markdown-window-placeholder]')).not.toBeNull()
    expect(harness.scope.getViewportRenders()).toHaveLength(0)
    harness.geometry.top = 100
    act(() => harness.scope.getViewportRenders().forEach(renderChunk => renderChunk()))
    expect(view.container.querySelector('[data-markdown-window-placeholder]')).toBeNull()
    expect(harness.onChunkLayout).toHaveBeenCalled()
  })

  test('ignores an old non-intersection callback after the chunk became visible', () => {
    const harness = viewportHarness()
    const view = harness.mount()
    harness.geometry.top = 100
    act(() => harness.scope.getViewportRenders().forEach(renderChunk => renderChunk()))
    harness.notify(false)
    expect(view.container.querySelector('[data-markdown-window-placeholder]')).toBeNull()
  })

  test('preserves rich height when leaving the viewport and after an outer row remount', () => {
    const harness = viewportHarness(100)
    const content = 'Stable completed content.'
    const view = harness.mount(content)
    harness.geometry.top = 4_000
    harness.notify(false)
    expect(view.container.querySelector('[data-markdown-window-chunk]')).toHaveStyle({
      minHeight: '2407px',
    })
    view.unmount()
    const reopened = harness.mount(content)
    expect(reopened.container.querySelector('[data-markdown-window-placeholder]')).not.toBeNull()
    expect(reopened.container.querySelector('[data-markdown-window-chunk]')).toHaveStyle({
      minHeight: '2407px',
    })
  })

  test('does not reuse retained height for another content version or width', () => {
    const harness = viewportHarness(100)
    const content = 'Original completed content.'
    const view = harness.mount(content)
    view.unmount()
    harness.geometry.top = 4_000
    const changed = harness.mount('Different completed content.')
    expect(changed.container.querySelector('[data-markdown-window-chunk]')).toHaveStyle({
      minHeight: '120px',
    })
    changed.unmount()
    harness.geometry.width = 500
    const resized = harness.mount(content)
    expect(resized.container.querySelector('[data-markdown-window-chunk]')).toHaveStyle({
      minHeight: '120px',
    })
  })

  test('refreshes the real height after asynchronous layout but never caches the placeholder size', () => {
    const harness = viewportHarness(100)
    const content = 'A completed block with delayed image sizing.'
    const view = harness.mount(content)
    harness.geometry.richHeight = 3_100
    act(() => harness.resizes.forEach(callback => callback([], {} as ResizeObserver)))
    expect(harness.scope.getHeight(content, 736)).toBe(3_100)
    harness.geometry.top = 4_000
    harness.notify(false)
    expect(view.container.querySelector('[data-markdown-window-chunk]')).toHaveStyle({
      minHeight: '3100px',
    })
    act(() => harness.resizes.forEach(callback => callback([], {} as ResizeObserver)))
    expect(harness.scope.getHeight(content, 736)).toBe(3_100)
  })

  test('keeps hidden viewport chunks lazy until the viewport is revealed', () => {
    const harness = viewportHarness(100)
    harness.geometry.rootWidth = 0
    const view = harness.mount()
    expect(view.container.querySelector('[data-markdown-window-placeholder]')).not.toBeNull()
    harness.geometry.rootWidth = 1_200
    act(() => harness.resizes.forEach(callback => callback([], {} as ResizeObserver)))
    expect(view.container.querySelector('[data-markdown-window-placeholder]')).toBeNull()
  })

  test('keeps indivisible long chunks mounted when the streamed eager flag ends', () => {
    const harness = viewportHarness()
    const content = 'Long atomic content. '.repeat(300)
    const view = harness.mount(content, true)
    const rich = view.container.querySelector('[data-rich-markdown]')
    view.rerender(
      <MarkdownWindowingContext.Provider value={harness.scope}>
        <WindowedMarkdownChunk content={content} chunkIndex={0} eager={false}>
          <p data-rich-markdown>Complete Markdown</p>
        </WindowedMarkdownChunk>
      </MarkdownWindowingContext.Provider>
    )
    expect(view.container.querySelector('[data-rich-markdown]')).toBe(rich)
    expect(view.container.querySelector('[data-markdown-window-placeholder]')).toBeNull()
    expect(harness.intersections).toHaveLength(0)
  })

  test('does not cache growing eager atomic snapshots or evict learned historical heights', () => {
    const harness = viewportHarness()
    harness.scope.setHeight('Previously measured historical chunk.', 736, 2_407)
    const cacheHeight = vi.spyOn(harness.scope, 'setHeight')
    const view = harness.mount('```ts\n' + 'const value = 1;\n'.repeat(300), true)
    for (let update = 0; update < 300; update += 1) {
      const content = '```ts\n' + 'const value = 1;\n'.repeat(301 + update)
      view.rerender(
        <MarkdownWindowingContext.Provider value={harness.scope}>
          <WindowedMarkdownChunk content={content} chunkIndex={0} eager={false}>
            <p data-rich-markdown>Complete Markdown</p>
          </WindowedMarkdownChunk>
        </MarkdownWindowingContext.Provider>
      )
    }
    act(() => harness.resizes.forEach(callback => callback([], {} as ResizeObserver)))

    expect(cacheHeight).not.toHaveBeenCalled()
    expect(harness.scope.getHeight('Previously measured historical chunk.', 736)).toBe(2_407)
    expect(view.container.querySelector('[data-markdown-window-placeholder]')).toBeNull()
  })

  test('caches only the completed non-eager version of a streamed bounded chunk', () => {
    const harness = viewportHarness()
    const original = 'A partial streamed chunk.'
    const completed = original + ' The completed chunk.'
    const cacheHeight = vi.spyOn(harness.scope, 'setHeight')
    const view = harness.mount(original, true)
    view.rerender(
      <MarkdownWindowingContext.Provider value={harness.scope}>
        <WindowedMarkdownChunk content={completed} chunkIndex={0} eager>
          <p data-rich-markdown>Complete Markdown</p>
        </WindowedMarkdownChunk>
      </MarkdownWindowingContext.Provider>
    )
    expect(cacheHeight).not.toHaveBeenCalled()
    view.rerender(
      <MarkdownWindowingContext.Provider value={harness.scope}>
        <WindowedMarkdownChunk content={completed} chunkIndex={0} eager={false}>
          <p data-rich-markdown>Complete Markdown</p>
        </WindowedMarkdownChunk>
      </MarkdownWindowingContext.Provider>
    )

    expect(harness.scope.getHeight(original, 736)).toBeUndefined()
    expect(harness.scope.getHeight(completed, 736)).toBe(2_407)
  })

  test('backfills the true eager height when completion immediately shows a far placeholder', () => {
    const harness = viewportHarness(4_000, 3_100)
    const content = 'A bounded far chunk that becomes temporarily eager.'
    const view = harness.mount(content)
    view.rerender(
      <MarkdownWindowingContext.Provider value={harness.scope}>
        <WindowedMarkdownChunk content={content} chunkIndex={0} eager>
          <p data-rich-markdown>Complete Markdown</p>
        </WindowedMarkdownChunk>
      </MarkdownWindowingContext.Provider>
    )
    expect(harness.scope.getHeight(content, 736)).toBeUndefined()
    view.rerender(
      <MarkdownWindowingContext.Provider value={harness.scope}>
        <WindowedMarkdownChunk content={content} chunkIndex={0} eager={false}>
          <p data-rich-markdown>Complete Markdown</p>
        </WindowedMarkdownChunk>
      </MarkdownWindowingContext.Provider>
    )

    expect(harness.scope.getHeight(content, 736)).toBe(3_100)
    expect(view.container.querySelector('[data-markdown-window-placeholder]')).not.toBeNull()
    expect(view.container.querySelector('[data-markdown-window-chunk]')).toHaveStyle({
      minHeight: '3100px',
    })
    view.unmount()
    const reopened = harness.mount(content)
    expect(reopened.container.querySelector('[data-markdown-window-chunk]')).toHaveStyle({
      minHeight: '3100px',
    })
  })

  test.each(['content', 'width'])(
    'does not backfill an eager height when the completed %s differs',
    changed => {
      const harness = viewportHarness(4_000, 3_100)
      const original = 'A bounded temporarily eager chunk.'
      const view = harness.mount(original)
      view.rerender(
        <MarkdownWindowingContext.Provider value={harness.scope}>
          <WindowedMarkdownChunk content={original} chunkIndex={0} eager>
            <p data-rich-markdown>Complete Markdown</p>
          </WindowedMarkdownChunk>
        </MarkdownWindowingContext.Provider>
      )
      const content = changed === 'content' ? 'Another completed chunk.' : original
      if (changed === 'width') harness.geometry.width = 500
      view.rerender(
        <MarkdownWindowingContext.Provider value={harness.scope}>
          <WindowedMarkdownChunk content={content} chunkIndex={0} eager={false}>
            <p data-rich-markdown>Complete Markdown</p>
          </WindowedMarkdownChunk>
        </MarkdownWindowingContext.Provider>
      )

      expect(harness.scope.getHeight(content, harness.geometry.width)).toBeUndefined()
      expect(view.container.querySelector('[data-markdown-window-chunk]')).toHaveStyle({
        minHeight: '120px',
      })
    }
  )
})
