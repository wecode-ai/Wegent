import '@/i18n'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { copyTextToClipboard } from '@/lib/clipboard'
import type { EnvironmentInfo } from '@/types/environment'
import { EnvironmentSummaryOverview } from './EnvironmentSummaryOverview'

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))
const info: EnvironmentInfo = {
  additions: '0',
  deletions: '0',
  executionTarget: 'local',
  workspaceRoots: ['/work/first', '/work/second'],
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10000)
  vi.mocked(copyTextToClipboard).mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function copy(testId = 'environment-workspace-path-button') {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId))
  })
}

test('refreshes copy feedback for another path and removes its timer when unmounted', async () => {
  const { unmount } = render(<EnvironmentSummaryOverview devices={[]} info={info} />)
  await copy()
  expect(copyTextToClipboard).toHaveBeenCalledWith('/work/first')
  expect(screen.getByTestId('environment-workspace-path-button')).toContainElement(
    screen.getByRole('status')
  )
  act(() => vi.advanceTimersByTime(1500))
  await copy('environment-workspace-root-button-1')
  expect(screen.getByTestId('environment-workspace-root-button-1')).toContainElement(
    screen.getByRole('status')
  )
  act(() => vi.advanceTimersByTime(500))
  expect(screen.getByRole('status')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(1500))
  expect(screen.queryByRole('status')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  await copy()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

test('keeps feedback on the most recently requested path when clipboard completions arrive out of order', async () => {
  let finish!: () => void
  vi.mocked(copyTextToClipboard).mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  render(<EnvironmentSummaryOverview devices={[]} info={info} />)
  await copy()
  expect(screen.queryByRole('status')).toBeNull()
  await copy('environment-workspace-root-button-1')
  await act(async () => finish())
  expect(screen.getByTestId('environment-workspace-root-button-1')).toContainElement(
    screen.getByRole('status')
  )
  expect(screen.getByTestId('environment-workspace-path-button')).not.toContainElement(
    screen.getByRole('status')
  )
})

test('does not create an expiration timer for a late clipboard result after unmount', async () => {
  let finish!: () => void
  vi.mocked(copyTextToClipboard).mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  const { unmount } = render(<EnvironmentSummaryOverview devices={[]} info={info} />)
  await copy()
  unmount()
  const timers = vi.spyOn(globalThis, 'setTimeout')
  try {
    await act(async () => finish())
    expect(timers.mock.calls.some(([, delay]) => delay === 2000)).toBe(false)
  } finally {
    timers.mockRestore()
  }
})
