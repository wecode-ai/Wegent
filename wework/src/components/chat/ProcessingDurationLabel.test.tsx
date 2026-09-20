import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { ProcessingDurationLabel } from './ProcessingDurationLabel'

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  await i18n.changeLanguage('zh-CN')
})

describe('ProcessingDurationLabel', () => {
  test('ticks after one second and freezes at the turn completion timestamp', () => {
    vi.useFakeTimers()
    const startedAt = Date.parse('2026-09-16T10:00:00Z')
    vi.setSystemTime(startedAt)
    const { rerender } = render(
      <ProcessingDurationLabel startedAt={startedAt} completedAt={undefined} isRunning />
    )
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('处理中')
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('已处理 1秒')
    act(() => vi.advanceTimersByTime(242000))
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('已处理 4分钟 3秒')

    rerender(
      <ProcessingDurationLabel
        startedAt={startedAt}
        completedAt={startedAt + 243000}
        isRunning={false}
      />
    )
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('用时 4分钟 3秒')
    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.advanceTimersByTime(10000))
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('用时 4分钟 3秒')
  })

  test('restores elapsed time from timestamps after unmount and localizes English units', async () => {
    await i18n.changeLanguage('en')
    vi.useFakeTimers()
    const startedAt = Date.parse('2026-09-16T10:00:00Z')
    vi.setSystemTime(startedAt + 61000)
    const first = render(
      <ProcessingDurationLabel startedAt={startedAt} completedAt={undefined} isRunning />
    )
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('Working for 1m 1s')
    first.unmount()
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(startedAt + 70000)
    render(<ProcessingDurationLabel startedAt={startedAt} completedAt={undefined} isRunning />)
    expect(screen.getByTestId('processing-duration-label')).toHaveTextContent('Working for 1m 10s')
  })
})
