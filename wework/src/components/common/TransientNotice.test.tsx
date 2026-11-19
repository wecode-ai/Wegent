import { StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TransientNotice } from './TransientNotice'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('expires a plain notice once after its full display interval', () => {
  const clear = vi.fn()
  render(<TransientNotice message="Saved" onClear={clear} />)
  act(() => vi.advanceTimersByTime(2199))
  expect(screen.getByRole('status')).toHaveTextContent('Saved')
  expect(clear).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(1))
  expect(clear).toHaveBeenCalledOnce()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('cancels the previous message deadline without dismissing a newer notice', () => {
  const clearOld = vi.fn(),
    clearNew = vi.fn()
  const { rerender } = render(<TransientNotice message="Old" onClear={clearOld} />)
  act(() => vi.advanceTimersByTime(1000))
  rerender(<TransientNotice message="New" onClear={clearNew} />)
  act(() => vi.advanceTimersByTime(1200))
  expect(screen.getByRole('status')).toHaveTextContent('New')
  expect(clearOld).not.toHaveBeenCalled()
  expect(clearNew).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(1000))
  expect(clearNew).toHaveBeenCalledOnce()
})

test('cancels dismissal when its owner unmounts', () => {
  const clear = vi.fn()
  const { unmount } = render(<TransientNotice message="Pending" onClear={clear} />)
  expect(vi.getTimerCount()).toBe(1)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(2200))
  expect(clear).not.toHaveBeenCalled()
})

test('retains actionable notices and respects pending actions', () => {
  const clear = vi.fn(),
    undo = vi.fn()
  const action = { label: 'Undo', testId: 'notice-undo', onClick: undo, pending: false }
  const { rerender } = render(<TransientNotice message="Removed" onClear={clear} action={action} />)
  act(() => vi.advanceTimersByTime(10_000))
  expect(clear).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('notice-undo'))
  expect(undo).toHaveBeenCalledOnce()
  rerender(
    <TransientNotice message="Removed" onClear={clear} action={{ ...action, pending: true }} />
  )
  expect(screen.getByTestId('notice-undo')).toBeDisabled()
  fireEvent.click(screen.getByTestId('notice-undo'))
  expect(undo).toHaveBeenCalledOnce()
})

test('starts a fresh dismissal interval only after its action is removed', () => {
  const clear = vi.fn()
  const { rerender } = render(
    <TransientNotice
      message="Done"
      onClear={clear}
      action={{ label: 'Undo', testId: 'undo', onClick: vi.fn(), pending: false }}
    />
  )
  act(() => vi.advanceTimersByTime(5000))
  rerender(<TransientNotice message="Done" onClear={clear} />)
  act(() => vi.advanceTimersByTime(2199))
  expect(clear).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(1))
  expect(clear).toHaveBeenCalledOnce()
})

test.each([null, ''])('does not schedule an empty notice (%s)', message => {
  const clear = vi.fn()
  render(<TransientNotice message={message} onClear={clear} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(vi.getTimerCount()).toBe(0)
  expect(clear).not.toHaveBeenCalled()
})

test('preserves the dismissal deadline while the notice is hidden', () => {
  const clear = vi.fn()
  render(<TransientNotice message="Hidden" visible={false} onClear={clear} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  act(() => vi.advanceTimersByTime(2200))
  expect(clear).toHaveBeenCalledOnce()
})

test('owns exactly one deadline under StrictMode', () => {
  const clear = vi.fn()
  render(
    <StrictMode>
      <TransientNotice message="Saved" onClear={clear} />
    </StrictMode>
  )
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(2200))
  expect(clear).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

test('follows anchor resize and captured scroll, then drops placement when the anchor is removed', () => {
  const anchor = document.createElement('div')
  document.body.append(anchor)
  let left = 40,
    width = 200
  vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(left, 0, width, 30)
  )
  let notify!: () => void
  const disconnect = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        notify = callback
      }
      observe() {}
      disconnect = disconnect
    }
  )
  const clear = vi.fn(),
    ref = { current: anchor }
  const { rerender, unmount } = render(
    <TransientNotice message="Anchored" onClear={clear} horizontalAnchorRef={ref} />
  )
  const notice = screen.getByRole('status')
  expect(notice.style.left).toBe('140px')
  expect(notice.style.maxWidth).toBe('168px')
  left = 60
  width = 120
  act(() => notify())
  expect(notice.style.left).toBe('120px')
  expect(notice.style.maxWidth).toBe('88px')
  left = 100
  act(() => anchor.dispatchEvent(new Event('scroll', { bubbles: false })))
  expect(notice.style.left).toBe('160px')
  rerender(<TransientNotice message="Anchored" onClear={clear} />)
  expect(screen.getByRole('status').style.left).toBe('')
  expect(disconnect).toHaveBeenCalledOnce()
  unmount()
  anchor.remove()
})
