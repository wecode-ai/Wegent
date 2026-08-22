import { act, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useAnchoredMenuPosition } from './useAnchoredMenuPosition'

const rect = {
  x: 400,
  y: 170,
  top: 170,
  right: 500,
  bottom: 200,
  left: 400,
  width: 300,
  height: 30,
}

function AnchorProbe({ open }: { open: boolean }) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredMenuPosition({ open, anchorRef, menuRef })
  return (
    <div>
      <div ref={anchorRef} data-testid="anchor" />
      <div ref={menuRef} data-testid="menu-probe" />
      <span data-testid="position">{position ? JSON.stringify(position) : 'none'}</span>
    </div>
  )
}

describe('useAnchoredMenuPosition', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('re-anchors the menu to the trigger when the page scrolls', () => {
    const getBoundingClientRect = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ ...rect, toJSON: () => ({}) } as DOMRect)
    const { container } = render(<AnchorProbe open />)

    expect(JSON.parse(container.querySelector('[data-testid="position"]')!.textContent!)).toEqual({
      top: 206,
      right: 524,
      width: 300,
    })

    getBoundingClientRect.mockReturnValue({
      ...rect,
      top: 60,
      bottom: 90,
      toJSON: () => ({}),
    } as DOMRect)
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })

    expect(JSON.parse(container.querySelector('[data-testid="position"]')!.textContent!)).toEqual({
      top: 96,
      right: 524,
      width: 300,
    })
  })

  test('re-anchors the menu when the window resizes', () => {
    const getBoundingClientRect = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        ...rect,
        toJSON: () => ({}),
      } as DOMRect)
    const { container } = render(<AnchorProbe open />)

    getBoundingClientRect.mockReturnValue({
      ...rect,
      right: 620,
      width: 420,
      toJSON: () => ({}),
    } as DOMRect)
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(JSON.parse(container.querySelector('[data-testid="position"]')!.textContent!)).toEqual({
      top: 206,
      right: 404,
      width: 420,
    })
  })
})
