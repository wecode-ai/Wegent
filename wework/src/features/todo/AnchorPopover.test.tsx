import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AnchorPopover } from './AnchorPopover'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([false, true])('constrains the entire picker to the available space (wide=%s)', wide => {
  const anchor = document.createElement('button')
  document.body.append(anchor)
  const rect = { left: 20, right: 120, width: 100, top: 260, bottom: 290, height: 30 }
  vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => rect as DOMRect)
  vi.stubGlobal('innerHeight', 480)
  const { unmount } = render(
    <AnchorPopover anchor={anchor} title="项目" testId="picker" onClose={vi.fn()} wide={wide}>
      {Array.from({ length: 40 }, (_, index) => (
        <button key={index}>项目 {index}</button>
      ))}
    </AnchorPopover>
  )
  const picker = screen.getByTestId('picker')
  expect(picker).toHaveStyle({ bottom: '228px', maxHeight: '236px' })
  expect(picker).toHaveClass('flex', 'flex-col', 'overflow-hidden')
  expect(picker.lastElementChild).toHaveClass('min-h-0', 'overflow-y-auto')

  Object.assign(rect, { top: 40, bottom: 70 })
  fireEvent(window, new Event('resize'))
  expect(picker).toHaveStyle({ top: '78px', maxHeight: '386px' })
  expect(picker.style.bottom).toBe('')
  unmount()
  anchor.remove()
})

it('retains body ownership until the last popover closes and suspends dismissal events', () => {
  const anchor = document.createElement('button')
  document.body.append(anchor)
  const close = vi.fn()
  const first = render(
    <AnchorPopover anchor={anchor} title="First" testId="first" onClose={close}>
      <button>Action</button>
    </AnchorPopover>
  )
  const second = render(
    <AnchorPopover anchor={anchor} title="Second" testId="second" onClose={vi.fn()}>
      <button>Other</button>
    </AnchorPopover>
  )
  expect(document.body).toHaveAttribute('data-wework-anchor-popover-open')
  first.unmount()
  expect(document.body).toHaveAttribute('data-wework-anchor-popover-open')
  second.unmount()
  expect(document.body).not.toHaveAttribute('data-wework-anchor-popover-open')
  const suspended = render(
    <AnchorPopover anchor={anchor} title="Suspended" testId="suspended" onClose={close} suspended>
      <button>Action</button>
    </AnchorPopover>
  )
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.pointerDown(document.body)
  expect(close).not.toHaveBeenCalled()
  suspended.rerender(
    <AnchorPopover anchor={anchor} title="Active" testId="suspended" onClose={close}>
      <button>Action</button>
    </AnchorPopover>
  )
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
  suspended.unmount()
  anchor.remove()
})
