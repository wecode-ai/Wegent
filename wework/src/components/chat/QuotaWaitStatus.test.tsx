import '@/i18n'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { QuotaWaitStatus } from './QuotaWaitStatus'
import { ToolBlockItem } from './blocks/ToolBlockItem'

afterEach(() => vi.useRealTimers())

test('shows the persisted quota countdown and checks availability after reset', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-12T08:00:00Z'))
  const { rerender } = render(<QuotaWaitStatus wait={{ resumeAt: Date.now() + 2000 }} />)
  expect(screen.getByTestId('runtime-quota-wait-status')).toHaveTextContent('2秒')
  expect(screen.getByTestId('runtime-quota-wait-status')).toHaveTextContent('原模型自动继续')
  act(() => vi.advanceTimersByTime(2000))
  expect(screen.getByTestId('runtime-quota-wait-status')).toHaveTextContent('正在检查额度恢复情况')
  rerender(<QuotaWaitStatus wait={undefined} />)
  expect(screen.queryByTestId('runtime-quota-wait-status')).not.toBeInTheDocument()
  expect(vi.getTimerCount()).toBe(0)
  rerender(<QuotaWaitStatus wait={{ resumeAt: null }} />)
  act(() => vi.advanceTimersByTime(60_000))
  rerender(<QuotaWaitStatus wait={{ resumeAt: Date.now() + 2000 }} />)
  expect(screen.getByTestId('runtime-quota-wait-status')).toHaveTextContent('2秒')
})

test('does not invent a countdown when the service has not supplied a reset time', () => {
  render(<QuotaWaitStatus wait={{ resumeAt: null, nextCheckAt: Date.now() + 60_000 }} />)
  expect(screen.getByTestId('runtime-quota-wait-status')).toHaveTextContent('正在查询恢复时间')
})

test('announces recovery transitions while countdown ticks remain outside the live region', () => {
  vi.useFakeTimers()
  render(<QuotaWaitStatus wait={{ resumeAt: Date.now() + 3000 }} />)
  const announcement = screen.getByRole('status')
  const waiting = announcement.textContent
  expect(announcement).toHaveTextContent('等待用原模型自动继续')
  expect(announcement).not.toHaveTextContent('3秒')
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByTestId('runtime-quota-wait-status')).toHaveTextContent('2秒')
  expect(announcement.textContent).toBe(waiting)
  act(() => vi.advanceTimersByTime(2000))
  expect(screen.getByRole('status')).toHaveTextContent('正在检查额度恢复情况')
})

test('offers cancellation while quota waiting has no active model response', () => {
  const onCancel = vi.fn()
  render(<QuotaWaitStatus wait={{ resumeAt: null }} onCancel={onCancel} />)
  fireEvent.click(screen.getByTestId('cancel-quota-recovery'))
  expect(onCancel).toHaveBeenCalledOnce()
})

test('shows model overload countdown without proxy settings for a ChatGPT model', () => {
  vi.useFakeTimers()
  const block = {
    id: 'overload',
    type: 'tool' as const,
    toolName: 'runtime_reconnecting',
    status: 'streaming' as const,
    createdAt: Date.now(),
    toolInput: {
      retry_reason: 'overload',
      retry_at: Date.now() + 10_000,
      model_kind: 'codex-official',
    },
  }
  const { rerender } = render(<ToolBlockItem block={block} />)
  expect(screen.getByTestId('runtime-overload-wait-status')).toHaveTextContent('10秒')
  expect(screen.queryByTestId('runtime-reconnecting-open-proxy-settings')).not.toBeInTheDocument()
  act(() => vi.advanceTimersByTime(10_000))
  expect(screen.getByTestId('runtime-overload-wait-status')).toHaveTextContent('正在用原模型重试')
  rerender(<ToolBlockItem block={{ ...block, status: 'done' }} />)
  expect(screen.queryByTestId('runtime-overload-wait-status')).not.toBeInTheDocument()
  expect(vi.getTimerCount()).toBe(0)
})
