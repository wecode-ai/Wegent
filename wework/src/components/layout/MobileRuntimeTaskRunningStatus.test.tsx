import '@/i18n'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { MobileRuntimeTaskRunningStatus } from './MobileRuntimeTaskRunningStatus'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
} from '@/features/workbench/runtimeConversationCache'

afterEach(clearRuntimeConversationCacheForTests)

test('replaces the running spinner with a waiting label and restores it on progress', async () => {
  const address = { deviceId: 'device', taskId: 'task' }
  render(<MobileRuntimeTaskRunningStatus address={address} testId="mobile-status" />)
  expect(screen.getByTestId('mobile-status')).toHaveAttribute('aria-label', '运行中')
  act(() => {
    applyRuntimeConversationAction(address, { type: 'assistant_started', subtaskId: 'turn' })
    applyRuntimeConversationAction(address, {
      type: 'block_created',
      subtaskId: 'turn',
      block: {
        id: 'retry',
        type: 'tool',
        toolName: 'runtime_reconnecting',
        toolInput: { retry_reason: 'rate_limit' },
        status: 'streaming',
        createdAt: 1,
      },
    })
  })
  expect(screen.getByTestId('mobile-status')).toHaveAttribute('aria-label', '限流等待，自动重试中')
  expect(screen.getByTestId('mobile-status').querySelector('.animate-spin')).toBeNull()
  act(() => {
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'turn',
      itemId: 'resumed-message',
      content: 'Resumed',
    })
  })
  await waitFor(() =>
    expect(screen.getByTestId('mobile-status')).toHaveAttribute('aria-label', '运行中')
  )
  expect(screen.getByTestId('mobile-status').querySelector('.animate-spin')).not.toBeNull()
})
