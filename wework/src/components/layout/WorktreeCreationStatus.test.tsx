import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { WorktreeCreationStatus } from './WorktreeCreationStatus'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}))

let reducedMotion: boolean
let media: EventTarget
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10000)
  reducedMotion = false
  media = new EventTarget()
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return reducedMotion
      },
      addEventListener: media.addEventListener.bind(media),
      removeEventListener: media.removeEventListener.bind(media),
    }))
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('cycles phases without restarting on rerender and releases its clock on unmount', () => {
  const { rerender, unmount } = render(<WorktreeCreationStatus />)
  expect(screen.getByTestId('worktree-creation-status')).toHaveTextContent('定位当前提交…')
  act(() => vi.advanceTimersByTime(1200))
  expect(screen.getByTestId('worktree-creation-status')).toHaveTextContent('把新分支拎出来…')
  rerender(<WorktreeCreationStatus className="updated" />)
  act(() => vi.advanceTimersByTime(1200))
  expect(screen.getByTestId('worktree-creation-status')).toHaveTextContent('展开独立工作区…')
  act(() => vi.advanceTimersByTime(2400))
  expect(screen.getByTestId('worktree-creation-status')).toHaveTextContent('定位当前提交…')
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

test('keeps a static phase for reduced motion and stops an existing clock on preference changes', () => {
  reducedMotion = true
  const { unmount } = render(<WorktreeCreationStatus />)
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(5000))
  expect(screen.getByTestId('worktree-creation-status')).toHaveTextContent('定位当前提交…')
  act(() => {
    reducedMotion = false
    media.dispatchEvent(new Event('change'))
  })
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(2400))
  act(() => {
    reducedMotion = true
    media.dispatchEvent(new Event('change'))
  })
  expect(vi.getTimerCount()).toBe(0)
  expect(screen.getByTestId('worktree-creation-status')).toHaveTextContent('定位当前提交…')
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
