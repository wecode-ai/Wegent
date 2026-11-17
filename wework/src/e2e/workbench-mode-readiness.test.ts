// @vitest-environment node

import { expect, test, vi } from 'vitest'

import { createDesktopScenario } from '../../e2e/desktop/scenarios/workbench-mode.scenario.mjs'
import { createBarrier } from '../test/async-barrier'

vi.mock('../../e2e/desktop/modules/workbench-home-migration.mjs', () => ({
  createWorkbenchHomeMigrationScenario: () => ({ verify: vi.fn() }),
}))
vi.mock('../../e2e/desktop/modules/custom-model-output-budget.mjs', () => ({
  verifyCustomModelOutputBudget: vi.fn(),
}))

const confirmButton = '[data-testid="general-workbench-mode-confirm-button"]'
const focusHome = '[data-testid="focus-home"]'
const developerHome = '[data-testid="task-suggestion-categories"]'

test('mode switching acknowledges the restart click and waits for the replacement home', async () => {
  const confirmationRequested = createBarrier()
  const confirmationReady = createBarrier()
  const reconnectRequested = createBarrier()
  const reconnected = createBarrier()
  const homeRequested = createBarrier()
  const homeReady = createBarrier()
  let mode = 'developer'
  let pendingMode = mode
  let focusReady = false
  const command = vi.fn(
    async (action: string, selector: string, options?: { enabled?: boolean }) => {
      if (action === 'clickWhenEnabled' && selector.includes('general-workbench-mode-')) {
        if (selector === confirmButton)
          throw new Error('Restart interrupted the click acknowledgement')
        pendingMode = selector.includes('-focus-') ? 'focus' : 'developer'
      }
      if (selector === confirmButton && action === 'waitFor') {
        expect(options).toEqual({ enabled: true })
        if (pendingMode === 'focus') {
          confirmationRequested.release()
          await confirmationReady.promise
          focusReady = true
        }
      }
      if (selector === confirmButton && action === 'deferredClick') {
        if (pendingMode === 'focus') expect(focusReady).toBe(true)
        mode = pendingMode
      }
      if (action === 'waitFor' && selector === focusHome && pendingMode === 'focus') {
        homeRequested.release()
        await homeReady.promise
      }
      if (action === 'getAttribute') return selector.includes(`-${mode}-`) ? 'true' : 'false'
      if (action === 'getElementCount') {
        return String(Number(selector === focusHome ? mode === 'focus' : mode === 'developer'))
      }
      return ''
    }
  )
  const awaitReadyAfter = vi.fn(async (readyCount: number) => {
    expect(readyCount).toBe(4)
    if (mode === 'focus') {
      reconnectRequested.release()
      await reconnected.promise
    }
  })
  const scenario = await createDesktopScenario({})
  const verification = scenario.verify({ command, readyCount: 4, awaitReadyAfter })

  await confirmationRequested.promise
  expect(command).not.toHaveBeenCalledWith('deferredClick', confirmButton)
  confirmationReady.release()
  await reconnectRequested.promise
  expect(command).not.toHaveBeenCalledWith('waitFor', focusHome, expect.anything())
  reconnected.release()
  await homeRequested.promise
  const commandCount = command.mock.calls.length
  await Promise.resolve()
  expect(command).toHaveBeenCalledTimes(commandCount)
  homeReady.release()
  await verification

  expect(awaitReadyAfter).toHaveBeenCalledTimes(2)
  expect(command.mock.calls.filter(([action]) => action === 'deferredClick')).toEqual([
    ['deferredClick', confirmButton],
    ['deferredClick', confirmButton],
  ])
  expect(command).toHaveBeenCalledWith('waitFor', developerHome, { timeoutMs: 120_000 })
  expect(command).not.toHaveBeenCalledWith('clickWhenEnabled', confirmButton)
})

test('a confirmation readiness failure does not click or wait for a restart', async () => {
  const notReady = new Error('Mode confirmation is disabled')
  const command = vi.fn(async (action: string, selector: string) => {
    if (action === 'getAttribute') return 'true'
    if (action === 'getElementCount') return selector === focusHome ? '0' : '1'
    if (action === 'waitFor' && selector === confirmButton) throw notReady
    return ''
  })
  const awaitReadyAfter = vi.fn()
  const scenario = await createDesktopScenario({})

  await expect(scenario.verify({ command, readyCount: 4, awaitReadyAfter })).rejects.toBe(notReady)

  expect(command).toHaveBeenCalledWith('waitFor', confirmButton, { enabled: true })
  expect(command).not.toHaveBeenCalledWith('deferredClick', confirmButton)
  expect(awaitReadyAfter).not.toHaveBeenCalled()
})
