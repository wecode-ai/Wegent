// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { useAnchoredPortalMenu } from './useAnchoredPortalMenu'

let root: Root
let container: HTMLDivElement
let anchorTop = 60
function Probe({
  open = true,
  align = 'start',
  placement = 'best-fit',
}: {
  open?: boolean
  align?: 'start' | 'end'
  placement?: 'best-fit' | 'prefer-below'
}) {
  const anchor = useRef<HTMLDivElement>(null),
    menu = useRef<HTMLDivElement>(null)
  const layout = useAnchoredPortalMenu(open, anchor, menu, { align, placement })
  return (
    <>
      <div ref={anchor} data-role="anchor" />
      <div ref={menu} data-role="menu" />
      <output>{JSON.stringify(layout)}</output>
    </>
  )
}
const layout = () => JSON.parse(container.querySelector('output')!.textContent!)
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  anchorTop = 60
  vi.stubGlobal('innerWidth', 300)
  vi.stubGlobal('innerHeight', 200)
  vi.stubGlobal('ResizeObserver', undefined)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.role === 'anchor'
      ? new DOMRect(100, anchorTop, 40, 20)
      : new DOMRect(0, 0, 80, 30)
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('places the menu below its anchor using measured viewport space', () => {
  act(() => root.render(<Probe />))
  expect(layout()).toEqual({ left: 100, top: 88, maxHeight: 104 })
})
test('preserves best-fit and prefer-below placement choices', () => {
  anchorTop = 100
  act(() => root.render(<Probe />))
  expect(layout()).toEqual({ left: 100, top: 62, maxHeight: 84 })
  act(() => root.render(<Probe placement="prefer-below" />))
  expect(layout()).toEqual({ left: 100, top: 128, maxHeight: 64 })
})
test('aligns to the end and clamps the menu within a narrower viewport', () => {
  act(() => root.render(<Probe align="end" />))
  expect(layout().left).toBe(60)
  vi.stubGlobal('innerWidth', 100)
  act(() => window.dispatchEvent(new Event('resize')))
  expect(layout().left).toBe(12)
})
test('hides closed menu layout and measures the new position on reopening', () => {
  act(() => root.render(<Probe />))
  act(() => root.render(<Probe open={false} />))
  expect(layout()).toBeNull()
  anchorTop = 100
  act(() => root.render(<Probe />))
  expect(layout().top).toBe(62)
})
