// @vitest-environment node

import { expect, test, vi } from 'vitest'
import { verifyInteractionArchiving } from '../../e2e/desktop/modules/human-interaction-dismiss.mjs'
import { reloadMainWindow } from '../../e2e/desktop/modules/workspace-flows.mjs'
import { createBarrier } from '../test/async-barrier'

vi.mock('../../e2e/desktop/modules/workspace-flows.mjs', () => ({
  reloadMainWindow: vi.fn(),
}))
vi.mock('../../e2e/desktop/modules/executor-rpc.mjs', () => ({
  requestExecutor: vi.fn(async () => ({ messages: [{ id: 'original', role: 'user' }] })),
}))

test('finishes dismissal and observes its history before reloading to check persistence', async () => {
  const waiting = createBarrier()
  const committed = createBarrier()
  const archived = createBarrier()
  const historyReady = createBarrier()
  let dismissed = false
  let observedArchive = false
  const command = vi.fn(async (action: string, selector: string, options?: { text?: string }) => {
    if (action === 'getElementCount') return '0'
    if (action === 'click' && selector.includes('interaction-dismiss')) dismissed = true
    if (!dismissed || vi.mocked(reloadMainWindow).mock.calls.length) return ''
    if (action === 'waitFor' && selector.includes('interactions-pending-count')) {
      waiting.release()
      await committed.promise
    }
    if (
      action === 'waitFor' &&
      selector.includes('interaction-list-item') &&
      options?.text === '这条问题暂不处理。'
    ) {
      archived.release()
      await historyReady.promise
      observedArchive = true
    }
    return ''
  })
  vi.mocked(reloadMainWindow).mockImplementation(async () => {
    expect(observedArchive).toBe(true)
  })
  const verification = verifyInteractionArchiving({ command }, 1000, 'task')
  await waiting.promise
  expect(reloadMainWindow).not.toHaveBeenCalled()
  committed.release()
  await archived.promise
  expect(reloadMainWindow).not.toHaveBeenCalled()
  historyReady.release()
  await verification
  expect(reloadMainWindow).toHaveBeenCalledOnce()
})

test('does not replay a stale inbox refresh when history never settles', async () => {
  const command = vi.fn(async (action: string, selector: string) => {
    if (action === 'getElementCount') return '0'
    if (action === 'getAttribute') return '3'
    if (action === 'waitFor' && selector.includes('interactions-pending-count')) {
      throw new Error('stale inbox')
    }
    return ''
  })

  await expect(verifyInteractionArchiving({ command }, 1000, 'task')).rejects.toThrow('stale inbox')

  const refreshClicks = command.mock.calls.filter(
    ([action, selector]) =>
      action === 'clickWhenEnabled' && selector.includes('interactions-refresh')
  )
  expect(refreshClicks).toHaveLength(1)
})
