import { expect, test, vi } from 'vitest'
import { dispatchDesktopControlWheel } from './desktop-control-wheel'

test('sends horizontal and vertical pixel input to the renderer without forcing DOM scroll', () => {
  const element = document.createElement('div')
  const handleWheel = vi.fn((event: WheelEvent) => event.preventDefault())
  element.addEventListener('wheel', handleWheel)

  expect(dispatchDesktopControlWheel(element, '{"deltaX":600,"deltaY":1200}')).toBe(
    '{"defaultPrevented":true}'
  )
  expect(handleWheel).toHaveBeenCalledWith(
    expect.objectContaining({
      deltaX: 600,
      deltaY: 1200,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      bubbles: true,
      composed: true,
    })
  )
  expect(element.scrollTop).toBe(0)
  expect(element.scrollLeft).toBe(0)
})

test.each(['{"deltaX":"600"}', '{"deltaY":null}', '{"deltaY":1e999}'])(
  'rejects invalid wheel input before dispatch: %s',
  value => {
    const element = document.createElement('div')
    const listener = vi.fn()
    element.addEventListener('wheel', listener)
    expect(() => dispatchDesktopControlWheel(element, value)).toThrow('finite deltaX and deltaY')
    expect(listener).not.toHaveBeenCalled()
  }
)
