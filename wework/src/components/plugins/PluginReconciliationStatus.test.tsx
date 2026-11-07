import '@/i18n'
import { act, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { PluginReconciliationStatus } from './PluginReconciliationStatus'

test('shows real stages and elapsed time without resetting the clock between stages', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-05T10:00:00Z'))
  const startedAt = Date.now()
  const view = render(<PluginReconciliationStatus stage="syncing" startedAt={startedAt} />)
  try {
    expect(screen.getByRole('status')).toHaveTextContent('2/3 核对并修复本机插件')
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByText('已用时 3 秒')).toBeInTheDocument()
    view.rerender(<PluginReconciliationStatus stage="verifying" startedAt={startedAt} />)
    expect(screen.getByRole('status')).toHaveTextContent('3/3 确认安装结果')
    expect(screen.getByText('已用时 3 秒')).toBeInTheDocument()
  } finally {
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  }
})
