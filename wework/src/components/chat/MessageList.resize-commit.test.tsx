import { act, cleanup, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import {
  useConversationVirtualizer,
  type ConversationVirtualizer,
} from '@wegent/collaboration/conversation/useConversationVirtualizer'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test.each([3, 40])('size and scroll commits preserve their separate timing: %s rows', count => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  const viewport = document.createElement('div')
  let firstRowHeight = 100
  document.body.append(viewport)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return new DOMRect(0, this.dataset.testid === 'resize-list' ? -viewport.scrollTop : 0, 800, 200)
  })
  Object.defineProperties(viewport, {
    clientHeight: { value: 200 },
    clientWidth: { value: 800 },
    scrollHeight: { get: () => firstRowHeight + (count - 1) * 100 },
    offsetHeight: { value: 200 },
    offsetWidth: { value: 800 },
  })
  viewport.scrollTo = vi.fn(options => {
    if (typeof options === 'object') viewport.scrollTop = options.top ?? viewport.scrollTop
  })
  const scrollElementRef = { current: viewport }
  const engine = { current: null as ConversationVirtualizer | null }
  let updateHeader!: () => void
  function Fixture() {
    const listRef = useRef<HTMLDivElement>(null)
    const [header, setHeader] = useState('Before')
    updateHeader = () => setHeader('After')
    const { virtualizer } = useConversationVirtualizer({
      count,
      enabled: true,
      estimateSize: () => 100,
      scrollElementRef,
      listRef,
      virtualizerRef: engine,
      initialDistanceFromBottomPx: 0,
    })
    return (
      <>
        <div data-testid="pending-header">{header}</div>
        <div ref={listRef} data-testid="resize-list">
          {virtualizer.getVirtualItems().map(item => (
            <div key={item.key} data-index={item.index} style={{ height: item.size }} />
          ))}
        </div>
      </>
    )
  }
  render(<Fixture />, { container: viewport })
  const initialOffset = (count - 2) * 100
  expect(viewport.scrollTop).toBe(initialOffset)
  act(() => {
    engine.current!.cancelScroll()
    viewport.dispatchEvent(new Event('scroll'))
  })
  act(() => {
    updateHeader()
    firstRowHeight = 150
    engine.current!.resizeItem(0, 150)
    expect(viewport.scrollTop).toBe(initialOffset + 50)
    expect(screen.getByTestId('pending-header')).toHaveTextContent('Before')
  })
  expect(screen.getByTestId('pending-header')).toHaveTextContent('After')
  act(() => {
    viewport.scrollTop = 0
    viewport.dispatchEvent(new Event('scroll'))
    expect(screen.getByTestId('resize-list').firstElementChild).toHaveAttribute('data-index', '0')
  })
})
