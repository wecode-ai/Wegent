// @vitest-environment node

import { expect, test, vi } from 'vitest'
import { verifyArchivedTaskInteractionCleanup } from '../../e2e/desktop/modules/human-interaction-archived-task.mjs'

vi.mock('../../e2e/desktop/modules/shared.mjs', () => ({
  selectE2EModel: vi.fn(),
}))
vi.mock('../../e2e/desktop/modules/workspace-flows.mjs', () => ({
  reloadMainWindow: vi.fn(),
  waitForWorkbenchDebugState: vi.fn(async () => ({
    workbench: { currentRuntimeTask: { taskId: 'archived-task' } },
  })),
}))
vi.mock('../../e2e/desktop/modules/executor-rpc.mjs', () => ({
  requestExecutor: vi.fn(async () => ({ code: 'task_archived' })),
}))

test('archive cleanup clicks refresh once after the current inventory refresh settles', async () => {
  let settleInventory!: () => void
  let reachedRefresh!: () => void
  const loading = new Promise<void>(resolve => {
    settleInventory = resolve
  })
  const waiting = new Promise<void>(resolve => {
    reachedRefresh = resolve
  })
  let refreshClicks = 0
  const command = vi.fn(async (action: string, selector: string) => {
    if (selector.includes('[data-testid="interactions-refresh"]')) {
      expect(action).toBe('clickWhenEnabled')
      reachedRefresh()
      await loading
      refreshClicks++
    }
    if (selector.includes('[data-testid="interactions-empty"]')) expect(refreshClicks).toBe(1)
    if (action === 'getElementCount') return '0'
    return ''
  })
  const verification = verifyArchivedTaskInteractionCleanup({ command }, 1000)
  await waiting
  expect(refreshClicks).toBe(0)
  expect(
    command.mock.calls.some(([, selector]) =>
      selector.includes('[data-testid="interactions-empty"]')
    )
  ).toBe(false)
  settleInventory()
  await verification
  expect(refreshClicks).toBe(1)
  expect(command).toHaveBeenCalledWith(
    'waitFor',
    expect.stringContaining('[data-testid="interactions-pending-count"]'),
    { text: '0', stableMs: 6_000, timeoutMs: 1000 }
  )
  const { requestExecutor } = await import('../../e2e/desktop/modules/executor-rpc.mjs')
  expect(requestExecutor).toHaveBeenCalledWith(
    { command },
    'runtime.tasks.get',
    { taskId: 'archived-task' },
    1000
  )
})
