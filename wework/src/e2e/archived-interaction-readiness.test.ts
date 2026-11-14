// @vitest-environment node

import { beforeEach, expect, test, vi } from 'vitest'
import { verifyArchivedTaskInteractionCleanup } from '../../e2e/desktop/modules/human-interaction-archived-task.mjs'
import { DEFAULT_MODEL_LABEL, MODEL_PROVIDER_ID } from '../../e2e/desktop/modules/shared.mjs'
import { requestExecutor } from '../../e2e/desktop/modules/executor-rpc.mjs'
import { createBarrier } from '../test/async-barrier'
import { loadDesktopCheckpointCatalog } from '../../e2e/desktop/checkpoint-catalog.mjs'

vi.mock('../../e2e/desktop/modules/executor-rpc.mjs', () => ({
  requestExecutor: vi.fn(async () => ({ code: 'task_archived' })),
}))

beforeEach(() => vi.clearAllMocks())

test('the archive verifier regression selects its existing CI checkpoint', () => {
  expect(
    loadDesktopCheckpointCatalog().PATH_TARGETS.get(
      'wework/src/e2e/archived-interaction-readiness.test.ts'
    )
  ).toEqual(['core:human-interactions'])
})

function fixture(state: 'ready' | 'loading', failure?: Error) {
  const waiting = createBarrier()
  const refreshed = createBarrier()
  let archived = false
  let historyReady = false
  let refreshClicks = 0
  const control = {
    readyCount: 1,
    awaitReadyAfter: vi.fn(async () => ({})),
    command: vi.fn(async (action: string, selector: string, options?: unknown) => {
      if (action === 'waitFor' && selector.includes('interactions-history-count'))
        historyReady = true
      if (selector.includes('interaction-open-original')) expect(historyReady).toBe(true)
      if (selector.includes('interactions-refresh')) {
        expect(archived).toBe(true)
        expect(action).toBe('clickWhenEnabled')
        expect(options).toBeUndefined()
        waiting.release()
        if (failure) throw failure
        await refreshed.promise
        refreshClicks++
      }
      if (action === 'waitFor' && /interactions-(empty|pending-count)/.test(selector)) {
        expect(refreshClicks).toBe(1)
        expect(options).toMatchObject({ timeoutMs: 1000 })
      }
      if (selector.includes('runtime-local-task-archive-toast-')) archived = true
      if (action === 'getWorkbenchDebugSnapshot')
        return JSON.stringify({ workbench: { currentRuntimeTask: { taskId: 'archived-task' } } })
      if (action === 'getText' && selector.includes('model-selector-button'))
        return DEFAULT_MODEL_LABEL
      if (action === 'getAttribute' && selector.includes('model-selector-button'))
        return MODEL_PROVIDER_ID
      if (action === 'getStartupSplashSnapshot') return '{"state":"closed"}'
      if (action === 'getElementCount') return '0'
      return ''
    }),
  }
  if (state === 'ready') refreshed.release()
  return { control, waiting, refreshed, refreshClicks: () => refreshClicks }
}

test.each(['ready', 'loading'] as const)(
  'archived interaction cleanup waits for inventory that is %s and refreshes once',
  async state => {
    const { control, waiting, refreshed, refreshClicks } = fixture(state)
    const verification = verifyArchivedTaskInteractionCleanup(control, 1000)
    try {
      await Promise.race([waiting.promise, verification])
      if (state === 'loading') {
        expect(refreshClicks()).toBe(0)
        expect(
          control.command.mock.calls.some(([, selector]) => selector.includes('interactions-empty'))
        ).toBe(false)
      }
    } finally {
      refreshed.release()
    }
    await verification
    expect(control.command).toHaveBeenCalledWith(
      'clickWhenEnabled',
      expect.stringContaining('[data-testid="interactions-history"]')
    )
    expect(refreshClicks()).toBe(1)
    expect(
      control.command.mock.calls.filter(
        ([action, selector]) =>
          action === 'waitFor' && /interactions-(empty|pending-count)/.test(selector)
      )
    ).toHaveLength(3)
    expect(control.command).toHaveBeenCalledWith(
      'waitFor',
      expect.stringContaining('[data-testid="interactions-pending-count"]'),
      { text: '0', stableMs: 6000, timeoutMs: 1000 }
    )
    expect(
      control.command.mock.calls.filter(([action]) => action === 'reloadMainWindow')
    ).toHaveLength(1)
    expect(control.awaitReadyAfter).toHaveBeenCalledExactlyOnceWith(1)
    expect(requestExecutor).toHaveBeenCalledExactlyOnceWith(
      control,
      'runtime.tasks.get',
      { taskId: 'archived-task' },
      1000
    )
  }
)

test('refresh readiness failure stops cleanup and reload without retrying', async () => {
  const failure = new Error('Refresh remained disabled within the shared action budget')
  const { control } = fixture('ready', failure)
  await expect(verifyArchivedTaskInteractionCleanup(control, 1000)).rejects.toBe(failure)
  expect(
    control.command.mock.calls.filter(([, selector]) => selector.includes('interactions-refresh'))
  ).toHaveLength(1)
  expect(
    control.command.mock.calls.some(
      ([action, selector]) =>
        action === 'reloadMainWindow' || /interactions-(empty|pending-count)/.test(selector)
    )
  ).toBe(false)
  expect(control.awaitReadyAfter).not.toHaveBeenCalled()
  expect(requestExecutor).not.toHaveBeenCalled()
})
