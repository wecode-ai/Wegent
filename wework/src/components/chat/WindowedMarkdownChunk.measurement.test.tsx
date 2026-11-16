import { useLayoutEffect, useRef } from 'react'
import { render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import {
  createMarkdownWindowingScope,
  MarkdownWindowingContext,
} from '../../../../packages/collaboration/src/markdown/MarkdownWindowingScope'
import { WindowedMarkdownChunk } from '../../../../packages/collaboration/src/markdown/WindowedMarkdownChunk'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test.each([
  { width: 600, expected: 500 },
  { width: 480, expected: 120 },
])('first parent measurement uses only the cached current width: $width', ({ width, expected }) => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const chunk = this.hasAttribute('data-markdown-window-chunk')
    const height = chunk ? Number.parseFloat(this.style.minHeight) || 120 : 400
    const top = chunk ? 10000 : 0
    return { width, height, top, bottom: top + height, left: 0, right: width } as DOMRect
  })
  const content = 'Previously measured Markdown'
  const scope = createMarkdownWindowingScope(undefined, () => {})
  scope.setHeight(content, 600, 500)
  const measurements: number[] = []
  function VirtualRow() {
    const rowRef = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
      const chunk = rowRef.current!.querySelector<HTMLElement>('[data-markdown-window-chunk]')!
      measurements.push(chunk.getBoundingClientRect().height)
    }, [])
    return (
      <MarkdownWindowingContext.Provider value={scope}>
        <div ref={rowRef}>
          <WindowedMarkdownChunk chunkIndex={0} content={content} eager={false}>
            <p>{content}</p>
          </WindowedMarkdownChunk>
        </div>
      </MarkdownWindowingContext.Provider>
    )
  }
  const { container } = render(<VirtualRow />)
  expect(measurements).toEqual([expected])
  expect(container.querySelector('[data-markdown-window-placeholder]')).not.toBeNull()
})
