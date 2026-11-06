import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { RuntimeWorkLoadStatus } from './RuntimeWorkLoadStatus'

describe('RuntimeWorkLoadStatus', () => {
  test('shows first load and keeps background refresh and successful empty results silent', () => {
    const { rerender } = render(
      <RuntimeWorkLoadStatus load={{ phase: 'loading', error: null }} hasSnapshot={false} />
    )
    expect(screen.getByRole('status')).toHaveTextContent('正在加载任务')
    rerender(<RuntimeWorkLoadStatus load={{ phase: 'refreshing', error: null }} hasSnapshot />)
    expect(screen.queryByTestId('runtime-work-load-status')).not.toBeInTheDocument()
    rerender(<RuntimeWorkLoadStatus load={{ phase: 'ready', error: null }} hasSnapshot />)
    expect(screen.queryByTestId('runtime-work-load-status')).not.toBeInTheDocument()
  })

  test('keeps an explicit local retry for initial and refresh failures', async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(
      <RuntimeWorkLoadStatus
        load={{ phase: 'error', error: 'Request timed out' }}
        hasSnapshot={false}
        onRetry={onRetry}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('任务加载失败')
    await userEvent.click(screen.getByTestId('runtime-work-load-retry'))
    expect(onRetry).toHaveBeenCalledOnce()
    rerender(
      <RuntimeWorkLoadStatus
        load={{ phase: 'error', error: 'Request timed out' }}
        hasSnapshot
        onRetry={onRetry}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('仍显示上次结果')
  })
})
