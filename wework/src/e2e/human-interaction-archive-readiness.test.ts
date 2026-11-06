// @vitest-environment node

import { beforeEach, expect, test, vi } from 'vitest'
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

beforeEach(() => vi.clearAllMocks())

test.each(['ready', 'loading'])(
  'archive cleanup clicks refresh once after inventory is %s',
  async state => {
    let settleInventory!: () => void
    let reachedRefresh!: () => void
    const loading = new Promise<void>(resolve => {
      settleInventory = resolve
    })
    const waiting = new Promise<void>(resolve => {
      reachedRefresh = resolve
    })
    let refreshClicks = 0
    if (state === 'ready') settleInventory()
    const command = vi.fn(async (action: string, selector: string, options?: unknown) => {
      if (selector.includes('[data-testid="interactions-refresh"]')) {
        expect(action).toBe('clickWhenEnabled')
        expect(options).toBeUndefined()
        reachedRefresh()
        await loading
        refreshClicks++
      }
      if (action === 'waitFor' && /interactions-(empty|pending-count)/.test(selector)) {
        expect(refreshClicks).toBe(1)
        expect(options).toMatchObject({ timeoutMs: 1000 })
      }
      if (action === 'getElementCount') return '0'
      return ''
    })
    const verification = verifyArchivedTaskInteractionCleanup({ command }, 1000)
    await Promise.race([waiting, verification])
    if (state === 'loading') {
      expect(refreshClicks).toBe(0)
      expect(
        command.mock.calls.some(([, selector]) =>
          selector.includes('[data-testid="interactions-empty"]')
        )
      ).toBe(false)
    }
    settleInventory()
    await verification
    expect(refreshClicks).toBe(1)
    expect(
      command.mock.calls.filter(
        ([action, selector]) =>
          action === 'waitFor' && /interactions-(empty|pending-count)/.test(selector)
      )
    ).toHaveLength(3)
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
    expect(requestExecutor).toHaveBeenCalledTimes(1)
    const { reloadMainWindow } = await import('../../e2e/desktop/modules/workspace-flows.mjs')
    expect(reloadMainWindow).toHaveBeenCalledTimes(1)
  }
)

test('refresh readiness failure stops cleanup assertions and reload without a retry', async () => {
  const failure = new Error('Refresh remained disabled within the shared action budget')
  const command = vi.fn(async (_action: string, selector: string) => {
    if (selector.includes('[data-testid="interactions-refresh"]')) throw failure
    return ''
  })
  await expect(verifyArchivedTaskInteractionCleanup({ command }, 1000)).rejects.toBe(failure)
  expect(
    command.mock.calls.filter(([, selector]) =>
      selector.includes('[data-testid="interactions-refresh"]')
    )
  ).toHaveLength(1)
  expect(
    command.mock.calls.some(([, selector]) => /interactions-(empty|pending-count)/.test(selector))
  ).toBe(false)
  const { requestExecutor } = await import('../../e2e/desktop/modules/executor-rpc.mjs')
  const { reloadMainWindow } = await import('../../e2e/desktop/modules/workspace-flows.mjs')
  expect(requestExecutor).not.toHaveBeenCalled()
  expect(reloadMainWindow).not.toHaveBeenCalled()
})
