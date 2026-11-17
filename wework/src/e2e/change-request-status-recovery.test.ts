// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { linkedChangeRequestTarget } from '@/api/changeRequests'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import { ChangeRequestUiObserver } from '@/features/workbench/changeRequestUiObserver'
import { createConnectionObserverFixture } from '@/test/connection-observer'
import type { DeviceCommandRequest } from '@/types/api'
import { recoverChangeRequestStatus } from '../../e2e/desktop/scenarios/change-request-status.scenario.mjs'

const target = linkedChangeRequestTarget('local', 'https://github.com/wecode-ai/Wegent/pull/2631')!
const statusSelector = '[data-testid="change-request-state"]'
const checksSelector = '[data-testid="change-request-checks"]'
const healthSelector =
  '[data-testid="environment-change-request-status-popover"] [data-testid="resource-observation-status"]'
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'change-request-recovery-'))
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

async function recoveryFixture(outcome = 'merged', startDelayMs = 4184) {
  const statePath = join(directory, 'provider-state')
  await writeFile(statePath, 'unavailable\n')
  const reply = createConnectionObserverFixture()
  const providerReads: Array<{ operation: string; state: string }> = []
  let captured!: () => void
  const firstRead = new Promise<void>(resolve => {
    captured = resolve
  })
  const executeCommand = async (_device: string, request: DeviceCommandRequest) => {
    const state = (await readFile(statePath, 'utf8')).trim()
    providerReads.push({ operation: request.command_key, state })
    captured()
    const delay =
      state === 'unavailable' ? 907 : request.command_key.endsWith('_start') ? startDelayMs : 8990
    await new Promise(resolve => setTimeout(resolve, delay))
    if (state === 'unavailable') throw new Error('git_cli_missing')
    const result = reply(request)
    const output = result.stdout as {
      observation: {
        refreshPending: boolean
        resourceStates: Array<{ data: Record<string, unknown> }>
      }
    }
    output.observation.refreshPending = outcome === 'refreshing'
    output.observation.resourceStates[0].data = {
      number: 2631,
      url: target.changeRequestUrl,
      state: outcome === 'open' ? 'OPEN' : 'MERGED',
      title: 'Provider recovery fixture',
      statusCheckRollup: { state: outcome === 'failure' ? 'FAILURE' : 'SUCCESS' },
    }
    if (outcome === 'error') throw new Error('provider_recovery_failed')
    return result
  }
  const observer = new ChangeRequestUiObserver({ executeCommand })
  observer.synchronize([target])
  let snapshot: TaskChangeRequestSnapshot | null = null
  let enabled = false
  let environmentOpen = false
  let statusOpen = false
  let pendingReads = 0
  let pending = Promise.resolve()
  const observe = (force: boolean) => {
    pendingReads++
    pending = pending
      .then(async () => {
        snapshot = await observer.read(target, force)
      })
      .finally(() => pendingReads--)
  }
  const text = (selector: string) => {
    if (selector === '[data-testid="environment-info-button"]') return '环境'
    if (selector === '[data-testid="environment-info-popover"]')
      return environmentOpen ? '环境' : ''
    if (!environmentOpen) return ''
    if (selector === '[data-testid="change-request-button"]') return '#2631'
    if (selector === statusSelector)
      return snapshot?.changeRequest?.state === 'merged' ? '已合并' : ''
    if (selector === checksSelector)
      return snapshot?.changeRequest?.checks === 'success' ? '检查通过' : ''
    if (selector === healthSelector)
      return statusOpen && !pendingReads && snapshot?.observation?.state === 'observing'
        ? '状态同步正常'
        : ''
    throw new Error(`Unexpected selector: ${selector}`)
  }
  const command = vi.fn(
    async (
      action: string,
      selector: string,
      options: { text?: string; timeoutMs?: number } = {}
    ) => {
      if (action === 'click') {
        if (selector === '[data-testid="change-request-status-switch"]') {
          enabled = true
          observe(false)
          await firstRead
        } else if (selector === '[data-testid="environment-info-button"]') {
          environmentOpen = !environmentOpen
          if (environmentOpen) observe(true)
        } else if (selector === '[data-testid="environment-change-request-status"]') {
          statusOpen = true
        } else if (selector !== '[data-testid="settings-back-button"]') {
          throw new Error(`Unexpected click: ${selector}`)
        }
        return ''
      }
      if (action === 'getAttribute') return String(enabled)
      if (action === 'getElementCount') return String(Number(environmentOpen))
      if (action !== 'waitFor') throw new Error(`Unexpected action: ${action}`)
      const deadline = Date.now() + (options.timeoutMs ?? 10_000)
      while (Date.now() < deadline) {
        const value = text(selector)
        if (value && (!options.text || value.includes(options.text))) return value
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error(`Timed out waiting for ${selector} containing ${options.text ?? ''}`)
    }
  )
  return { control: { command }, statePath, firstRead, providerReads }
}

async function finishRecovery(fixture: Awaited<ReturnType<typeof recoveryFixture>>) {
  const startedAt = Date.now()
  let result: { error: unknown } | undefined
  const recovery = recoverChangeRequestStatus(fixture.control, {
    statePath: fixture.statePath,
    uiTimeoutMs: 10_000,
  }).then(
    () => {
      result = { error: null }
    },
    (error: unknown) => {
      result = { error }
    }
  )
  await fixture.firstRead
  for (let step = 0; !result && step < 400; step++) {
    await vi.advanceTimersByTimeAsync(100)
    await new Promise(resolve => setImmediate(resolve))
  }
  expect(result, 'Recovery must finish within its existing step budgets').toBeDefined()
  await recovery
  return { error: result!.error, elapsedMs: Date.now() - startedAt }
}

test('repairs the provider before restarting observation with the recorded CI collection delays', async () => {
  const fixture = await recoveryFixture()
  const result = await finishRecovery(fixture)
  expect(result.error).toBeNull()
  expect(fixture.providerReads[0]).toEqual({
    operation: 'connection_observer_start',
    state: 'merged',
  })
  expect(fixture.providerReads.map(read => read.operation)).toEqual([
    'connection_observer_start',
    'connection_observer_refresh',
  ])
  const waits = fixture.control.command.mock.calls.filter(([action]) => action === 'waitFor')
  for (const [selector, expected] of [
    [statusSelector, '已合并'],
    [checksSelector, '检查通过'],
    [healthSelector, '状态同步正常'],
  ]) {
    expect(waits).toContainEqual(['waitFor', selector, { text: expected }])
  }
  expect(result.elapsedMs).toBeGreaterThanOrEqual(13_174)
  expect(result.elapsedMs).toBeLessThan(14_200)
})

test.each([
  ['open', statusSelector],
  ['failure', checksSelector],
  ['refreshing', healthSelector],
  ['error', statusSelector],
])(
  'rejects a %s provider result instead of reporting recovered status',
  async (outcome, selector) => {
    const fixture = await recoveryFixture(outcome)
    const result = await finishRecovery(fixture)
    expect(result.error).toBeInstanceOf(Error)
    expect((result.error as Error).message).toContain(`Timed out waiting for ${selector}`)
    const waits = fixture.control.command.mock.calls.filter(([action]) => action === 'waitFor')
    expect(waits.at(-1)?.[1]).toBe(selector)
  }
)

test('keeps the ten-second state deadline when a repaired provider still cannot finish', async () => {
  const fixture = await recoveryFixture('merged', 10_001)
  const result = await finishRecovery(fixture)
  expect((result.error as Error).message).toContain(`Timed out waiting for ${statusSelector}`)
  expect(result.elapsedMs).toBe(10_000)
})

test('does not re-enable observation if repairing its provider fixture fails', async () => {
  const fixture = await recoveryFixture()
  await expect(
    recoverChangeRequestStatus(fixture.control, {
      statePath: join(directory, 'missing', 'provider-state'),
      uiTimeoutMs: 10_000,
    })
  ).rejects.toThrow('ENOENT')
  expect(fixture.control.command).not.toHaveBeenCalled()
  expect(fixture.providerReads).toEqual([])
})
