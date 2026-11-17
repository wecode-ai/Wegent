// @vitest-environment node

import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DEFAULT_STEP_TIMEOUT_MS } from '../e2e/desktop/modules/shared.mjs'
import { createDesktopScenario as createStatusScenario } from '../e2e/desktop/scenarios/change-request-status.scenario.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/change-request-running-repair.scenario.mjs'

const fixture = vi.hoisted(() => ({ log: '' }))

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal()),
  readFile: vi.fn(async () => fixture.log),
  writeFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../e2e/desktop/scenarios/change-request-status.scenario.mjs', () => ({
  createDesktopScenario: vi.fn(async () => ({ verify: vi.fn().mockResolvedValue(undefined) })),
}))

const ENVIRONMENT = '[data-testid="environment-info-button"]'
const CHECKS = '[data-testid="change-request-checks"]'
const RUNTIME_OPERATION_TIMEOUT_MS = 30_000

beforeEach(() => {
  vi.useFakeTimers()
  fixture.log = started('old') + finished('old', true)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

test('awaits the same native refresh beyond the UI budget before the original DOM assertion', async () => {
  const run = await startVerification()
  await vi.advanceTimersByTimeAsync(11_000)
  expect(run.domWaits).toHaveLength(0)

  fixture.log += finished('old', true) + started('foreign') + finished('foreign', true)
  await vi.advanceTimersByTimeAsync(300)
  expect(run.domWaits).toHaveLength(0)

  fixture.log += finished('target', true)
  await vi.advanceTimersByTimeAsync(100)
  expect(await run.result).toBe(run.stopAfterPhase)
  expect(run.domWaits).toEqual([{ selector: CHECKS, options: { text: '检查失败' } }])
  expect(DEFAULT_STEP_TIMEOUT_MS).toBe(10_000)
  expect(writeFile).toHaveBeenCalledTimes(1)
  expect(run.base.verify).toHaveBeenCalledTimes(1)
  expect(readFile.mock.calls[0][0]).toMatch(/executor\.log$/)
  expect(
    run.control.command.mock.calls.filter(
      ([action, selector]) => action === 'click' && selector === ENVIRONMENT
    )
  ).toHaveLength(3)
})

test('rejects a failed refresh before the failure-check DOM assertion', async () => {
  const run = await startVerification()
  fixture.log += finished('target', false)
  await vi.advanceTimersByTimeAsync(100)
  expect(await run.result).toMatchObject({
    code: 'ERR_ASSERTION',
    actual: 'false',
    expected: 'true',
    message: expect.stringContaining('The native pull request refresh failed (target)'),
  })
  expect(run.domWaits).toHaveLength(0)
})

test('does not reuse a completed operation from before the click log offset', async () => {
  const run = await startVerification({ startOnClick: false })
  await vi.advanceTimersByTimeAsync(RUNTIME_OPERATION_TIMEOUT_MS)
  expect(await run.result).toMatchObject({ message: expect.stringContaining('Timed out waiting') })
  expect(run.domWaits).toHaveLength(0)
})

test('keeps one operation budget across start and completion', async () => {
  const run = await startVerification({ startOnClick: false })
  await vi.advanceTimersByTimeAsync(20_000)
  fixture.log += started('target')
  await vi.advanceTimersByTimeAsync(100)
  fixture.log += finished('foreign', true)
  await vi.advanceTimersByTimeAsync(9_900)
  expect(await run.result).toMatchObject({ message: expect.stringContaining('Timed out waiting') })
  expect(run.domWaits).toHaveLength(0)
})

test('preserves the original DOM error after a successful native refresh', async () => {
  const originalError = new Error('The failed checks were not rendered')
  const run = await startVerification({ domError: originalError })
  fixture.log += finished('target', true)
  await vi.advanceTimersByTimeAsync(100)
  expect(await run.result).toBe(originalError)
  expect(run.domWaits).toEqual([{ selector: CHECKS, options: { text: '检查失败' } }])
})

async function startVerification({ startOnClick = true, domError } = {}) {
  const scenario = await createDesktopScenario({
    resultDir: join(tmpdir(), 'change-request-refresh-results'),
    homePath: join(tmpdir(), 'change-request-refresh-home'),
    runtimeOperationTimeoutMs: RUNTIME_OPERATION_TIMEOUT_MS,
  })
  const base = await createStatusScenario.mock.results.at(-1).value
  const stopAfterPhase = new Error('The unchanged running-repair flow starts here')
  const domWaits = []
  let environmentClicks = 0
  const control = {
    command: vi.fn(async (action, selector, options) => {
      if (action === 'click' && selector === ENVIRONMENT) {
        environmentClicks += 1
        if (environmentClicks === 2 && startOnClick) fixture.log += started('target')
      }
      if (action === 'waitFor' && selector === CHECKS) {
        domWaits.push({ selector, options })
        if (domError) throw domError
      }
      if (action === 'click' && selector === '[data-testid="new-chat-button"]') throw stopAfterPhase
      return ''
    }),
  }
  const result = scenario.verify(control).catch(error => error)
  await vi.advanceTimersByTimeAsync(0)
  expect(writeFile).toHaveBeenCalledWith(expect.any(String), 'failure\n')
  return { result, control, domWaits, stopAfterPhase, base }
}

function started(requestId) {
  return `app IPC request started request_id=${requestId} method=device.execute_command command_key=connection_observer_refresh\n`
}

function finished(requestId, ok) {
  return `app IPC request finished request_id=${requestId} method=device.execute_command command_key=connection_observer_refresh elapsed_ms=11340 ok=${ok}\n`
}
