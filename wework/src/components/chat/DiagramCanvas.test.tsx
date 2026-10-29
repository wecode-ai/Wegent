import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { DiagramCanvas } from '../../../../packages/collaboration/src/markdown/DiagramCanvas'
const controller = vi.hoisted(() => ({
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  reset: vi.fn(),
  zoomWithWheel: vi.fn(),
  destroy: vi.fn(),
}))
const createPanzoom = vi.hoisted(() => vi.fn())
vi.mock('../../../../packages/collaboration/node_modules/@panzoom/panzoom', () => ({
  default: createPanzoom,
}))
beforeEach(() => {
  vi.clearAllMocks()
  createPanzoom.mockReturnValue(controller)
})

test.each([false, true])(
  'preserves vertical touch scrolling only in inline mode (fullscreen=%s)',
  fullscreen => {
    render(
      <DiagramCanvas
        artifact={{ svg: '<svg/>', src: 'data:image/svg+xml,test', width: 100, height: 50 }}
        fullscreen={fullscreen}
        onReady={vi.fn()}
        onError={vi.fn()}
      />
    )
    expect(createPanzoom).toHaveBeenCalledWith(
      screen.getByTestId('diagram-image'),
      expect.objectContaining({ touchAction: fullscreen ? 'none' : 'pan-y' })
    )
  }
)

test('retains zoom, reset and modified-wheel controls without consuming ordinary conversation scrolling', () => {
  const ready = vi.fn()
  const failed = vi.fn()
  const view = render(
    <DiagramCanvas
      artifact={{ svg: '<svg/>', src: 'data:image/svg+xml,test', width: 100, height: 50 }}
      onReady={ready}
      onError={failed}
    />
  )
  fireEvent.click(screen.getByTestId('diagram-zoom-in-button'))
  fireEvent.click(screen.getByTestId('diagram-zoom-out-button'))
  fireEvent.click(screen.getByTestId('diagram-zoom-reset-button'))
  expect(controller.zoomIn).toHaveBeenCalledOnce()
  expect(controller.zoomOut).toHaveBeenCalledOnce()
  expect(controller.reset).toHaveBeenCalledOnce()
  const canvas = screen.getByTestId('diagram-pan-canvas')
  const plain = new WheelEvent('wheel', { cancelable: true, deltaY: 100 })
  canvas.dispatchEvent(plain)
  expect(plain.defaultPrevented).toBe(false)
  expect(controller.zoomWithWheel).not.toHaveBeenCalled()
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const wheel = new WheelEvent('wheel', { cancelable: true, [modifier]: true, deltaY: 100 })
    canvas.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    expect(controller.zoomWithWheel).toHaveBeenLastCalledWith(wheel)
  }
  const image = screen.getByTestId('diagram-image')
  fireEvent.load(image)
  fireEvent.error(image)
  expect(ready).toHaveBeenCalledOnce()
  expect(failed).toHaveBeenCalledOnce()
  fireEvent(image, new CustomEvent('panzoomzoom', { detail: { scale: 4 } }))
  expect(screen.getByText('400%')).toBeInTheDocument()
  expect(screen.getByTestId('diagram-zoom-in-button')).toBeDisabled()
  view.unmount()
  expect(controller.destroy).toHaveBeenCalledOnce()
  controller.zoomWithWheel.mockClear()
  canvas.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, cancelable: true }))
  expect(controller.zoomWithWheel).not.toHaveBeenCalled()
})
