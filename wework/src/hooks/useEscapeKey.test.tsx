import { useRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useEscapeKey } from './useEscapeKey'

function Layer({ inert = false, onClose }: { inert?: boolean; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEscapeKey(onClose, true, ref)
  return (
    <section inert={inert}>
      <div ref={ref} data-testid={inert ? 'inactive-layer' : 'active-layer'} />
    </section>
  )
}

it('keeps hidden tab dialogs from consuming Escape or closing their drafts', () => {
  const hiddenClose = vi.fn()
  const visibleClose = vi.fn()
  const view = render(<Layer inert onClose={hiddenClose} />)
  expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true)
  expect(hiddenClose).not.toHaveBeenCalled()
  view.rerender(
    <>
      <Layer inert onClose={hiddenClose} />
      <Layer onClose={visibleClose} />
    </>
  )
  fireEvent.keyDown(screen.getByTestId('active-layer'), { key: 'Escape' })
  expect(visibleClose).toHaveBeenCalledOnce()
  expect(hiddenClose).not.toHaveBeenCalled()
})
