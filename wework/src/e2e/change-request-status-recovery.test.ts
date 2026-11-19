// @vitest-environment node

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { linkedChangeRequestTarget, type TaskChangeRequestSnapshot } from '@/api/changeRequests'
import { ChangeRequestUiObserver } from '@/features/workbench/changeRequestUiObserver'
import { createConnectionObserverFixture } from '@/test/connection-observer'
import type { DeviceCommandRequest } from '@/types/api'
import { createProvider } from '../../dsh/connection-git/provider.js'
import {
  prepareChangeRequestRecovery,
  recoverChangeRequestStatus,
} from '../../e2e/desktop/scenarios/change-request-status.scenario.mjs'

const fileIo = vi.hoisted(() => ({
  pending: new Set<Promise<unknown>>(),
}))

vi.mock('node:fs/promises', async importOriginal => {
  const filesystem = await importOriginal<typeof import('node:fs/promises')>()
  // Observe real disk operations without replacing their contents or failures.
  const track = <T>(operation: Promise<T>) => {
    const settled = operation.finally(() => fileIo.pending.delete(settled))
    fileIo.pending.add(settled)
    return settled
  }
  return {
    ...filesystem,
    readFile: (...args: Parameters<typeof filesystem.readFile>) =>
      track(filesystem.readFile(...args)),
    writeFile: (...args: Parameters<typeof filesystem.writeFile>) =>
      track(filesystem.writeFile(...args)),
  }
})

const target = linkedChangeRequestTarget(
  'native-runtime',
  'https://github.com/wecode-ai/Wegent/pull/2631'
)!
const statusSelector = '[data-testid="change-request-button"]'
const checksSelector = '[data-testid="change-request-checks"]'
const environmentSelector = '[data-testid="environment-info-button"]'
const healthSelector =
  '[data-testid="environment-change-request-status-popover"] [data-testid="resource-observation-status"]'
const activationFailure =
  'The target native change-request observer did not finish its new activation'
let directory: string

interface NativeLease {
  id: string
  consumer_key: string
  generation: string
  device_id: string
  source: Record<string, unknown>
  status: string
  expires_at: number
  error_code: string | null
}

interface FixtureOptions {
  outcome?: 'merged' | 'open' | 'failure' | 'refreshing' | 'error'
  alterLease?: (lease: NativeLease, old: NativeLease) => NativeLease
  duplicateLease?: boolean
  cachedError?: boolean
  startDelayMs?: number
  refreshDelayMs?: number
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'change-request-recovery-'))
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
})

afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

async function recoveryFixture(options: FixtureOptions = {}) {
  const statePath = join(directory, 'provider-state')
  const executorHome = join(directory, 'executor-home')
  const journalPath = join(executorHome, 'runtime-work', 'conversation-event-subscriptions.sqlite')
  await mkdir(join(executorHome, 'runtime-work'), { recursive: true })
  await writeFile(statePath, 'unavailable\n')
  const discovered = await createProvider('github').listResources(
    {
      git: {
        read: async ({ operation }: { operation: string }) => {
          if (operation === 'identity')
            return {
              profile: '["https://github.com","1"]',
              login: 'wework-e2e',
              instance: 'https://github.com',
            }
          if (operation === 'repository')
            return { data: { id: 2630, full_name: 'wecode-ai/Wegent' } }
          if (operation === 'object') return { data: { number: 2631 } }
          throw new Error(`Unexpected discovery operation: ${operation}`)
        },
      },
    },
    {
      kind: 'repository',
      query: JSON.stringify({
        instance: 'https://github.com',
        repository: 'wecode-ai/Wegent',
        monitoredObjects: [{ entityKind: 'change_request', number: 2631 }],
      }),
    }
  )
  const source = discovered.items[0]
  const observerId = (consumer: string, generation: string) =>
    createHash('sha256')
      .update(JSON.stringify(['observer', target.deviceId, consumer, generation]))
      .digest('hex')
  const old: NativeLease = {
    id: observerId('change-request-ui:old-consumer', 'old-generation'),
    consumer_key: 'change-request-ui:old-consumer',
    generation: 'old-generation',
    device_id: target.deviceId,
    source,
    status: 'stopped',
    expires_at: Date.now() + 90_000,
    error_code: null,
  }
  const saveJournal = async (lease = old) => {
    const observers = { [old.id]: old, [lease.id]: lease }
    if (options.duplicateLease && lease !== old && lease.status === 'observing') {
      const other = {
        ...lease,
        id: observerId(`${lease.consumer_key}-other`, `${lease.generation}-other`),
        consumer_key: `${lease.consumer_key}-other`,
        generation: `${lease.generation}-other`,
      }
      observers[other.id] = other
    }
    const database = new DatabaseSync(journalPath)
    try {
      database.exec(
        'CREATE TABLE IF NOT EXISTS records(section TEXT, id TEXT, value TEXT, PRIMARY KEY(section,id))'
      )
      const save = database.prepare("INSERT OR REPLACE INTO records VALUES('observers',?,?)")
      database.exec('BEGIN')
      for (const [id, value] of Object.entries(observers)) save.run(id, JSON.stringify(value))
      database.exec('COMMIT')
    } finally {
      database.close()
    }
  }
  await saveJournal()
  const reply = createConnectionObserverFixture()
  const providerReads: Array<{ operation: string; state: string }> = []
  const timeline: Array<{ event: string; at: number }> = []
  let captured!: () => void
  const firstRead = new Promise<void>(resolve => {
    captured = resolve
  })
  let lease = old
  const executeCommand = async (_device: string, request: DeviceCommandRequest) => {
    const state = (await readFile(statePath, 'utf8')).trim()
    providerReads.push({ operation: request.command_key, state })
    const start = request.command_key === 'connection_observer_start'
    const address = JSON.parse(request.args![0]) as { consumerKey: string; generation: string }
    if (start) {
      lease = {
        id: observerId(address.consumerKey, address.generation),
        consumer_key: address.consumerKey,
        generation: address.generation,
        device_id: target.deviceId,
        source,
        status: 'preparing',
        expires_at: Date.now() + 90_000,
        error_code: options.cachedError ? 'git_cli_missing' : null,
      }
      await saveJournal(lease)
    }
    timeline.push({ event: start ? 'start-request' : 'refresh-request', at: Date.now() })
    const delay = start ? (options.startDelayMs ?? 4184) : (options.refreshDelayMs ?? 8990)
    const collected = new Promise(resolve => setTimeout(resolve, delay))
    if (start) captured()
    await collected
    if (!start && options.outcome === 'error') throw new Error('provider_recovery_failed')
    if (start) {
      lease = { ...lease, status: 'observing', expires_at: Date.now() + 90_000 }
      if (options.alterLease) lease = options.alterLease(lease, old)
      // Native start persists its observing lease before returning its possibly cached facts.
      await saveJournal(lease)
      timeline.push({ event: 'lease-saved-before-ack', at: Date.now() })
    }
    const result = reply(request)
    const output = result.stdout as {
      observer: { id: string; source: Record<string, unknown> }
      observation: {
        source: Record<string, unknown>
        errorCode: string | null
        refreshPending: boolean
        resourceStates: Array<{ data: Record<string, unknown> }>
      }
    }
    output.observer.id = lease.id
    output.observer.source = source
    output.observation.source = source
    output.observation.errorCode = start ? lease.error_code : null
    output.observation.refreshPending = !start && options.outcome === 'refreshing'
    output.observation.resourceStates[0].data = {
      number: 2631,
      url: target.changeRequestUrl,
      state: start || options.outcome === 'open' ? 'OPEN' : 'MERGED',
      title: 'Cached provider recovery fixture',
      statusCheckRollup: { state: options.outcome === 'failure' ? 'FAILURE' : 'SUCCESS' },
    }
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
    if (selector === environmentSelector) return '环境'
    if (selector === '[data-testid="environment-info-popover"]')
      return environmentOpen ? '环境' : ''
    if (!environmentOpen) return ''
    if (selector === statusSelector)
      return snapshot?.changeRequest?.state === 'merged' ? '#2631 已合并' : '#2631'
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
      input: { text?: string; timeoutMs?: number; value?: string } = {}
    ) => {
      if (action === 'click') {
        if (selector === '[data-testid="change-request-status-switch"]') {
          enabled = true
          observe(false)
          await firstRead
        } else if (selector === environmentSelector) {
          environmentOpen = !environmentOpen
          if (environmentOpen) {
            timeline.push({ event: 'summary-opened', at: Date.now() })
            observe(true)
          }
        } else if (selector === '[data-testid="environment-change-request-status"]') {
          statusOpen = true
        } else if (selector !== '[data-testid="settings-back-button"]') {
          throw new Error(`Unexpected click: ${selector}`)
        }
        return ''
      }
      if (action === 'getAttribute') {
        if (
          selector === '[data-testid="change-request-status-switch"]' &&
          input.value === 'aria-checked'
        )
          return String(enabled)
        if (selector === statusSelector && input.value === 'aria-label') return text(selector)
        throw new Error(`Unexpected attribute: ${selector} ${input.value}`)
      }
      if (action === 'getElementCount') return String(Number(environmentOpen))
      if (action !== 'waitFor') throw new Error(`Unexpected action: ${action}`)
      const deadline = Date.now() + (input.timeoutMs ?? 10_000)
      while (Date.now() < deadline) {
        const value = text(selector)
        if (value && (!input.text || value.includes(input.text))) return value
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error(`Timed out waiting for ${selector} containing ${input.text ?? ''}`)
    }
  )
  return {
    control: { command },
    statePath,
    executorHome,
    journalPath,
    firstRead,
    providerReads,
    timeline,
    source,
  }
}

async function finishRecovery(fixture: Awaited<ReturnType<typeof recoveryFixture>>) {
  const startedAt = Date.now()
  let result: { error: unknown } | undefined
  const recovery = recoverChangeRequestStatus(fixture.control, {
    statePath: fixture.statePath,
    ...(await prepareChangeRequestRecovery(fixture.executorHome)),
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
  const flushFilesystem = async () => {
    // Only simulated native/UI delays advance time, never pending real disk operations.
    do {
      await Promise.allSettled([...fileIo.pending])
      await new Promise(resolve => setImmediate(resolve))
    } while (fileIo.pending.size)
  }
  await flushFilesystem()
  for (let step = 0; !result && step < 400; step++) {
    await vi.advanceTimersByTimeAsync(100)
    await flushFilesystem()
  }
  expect(result, 'Recovery must finish within its existing step budgets').toBeDefined()
  await recovery
  return { error: result!.error, elapsedMs: Date.now() - startedAt }
}

test.each([false, true])(
  'separates cached native start from forced refresh with cached error=%s',
  async cachedError => {
    const fixture = await recoveryFixture({ cachedError })
    const result = await finishRecovery(fixture)
    expect(result.error).toBeNull()
    expect(fixture.source).toMatchObject({
      providerId: '@wegent/dsh-connection-git/github',
      kind: 'repository',
      transport: 'cli',
      profile: '["https://github.com","1"]',
      id: '2630',
      name: 'wecode-ai/Wegent',
      monitoredObjects: [{ entityKind: 'change_request', number: 2631 }],
    })
    expect(fixture.providerReads).toEqual([
      { operation: 'connection_observer_start', state: 'merged' },
      { operation: 'connection_observer_refresh', state: 'merged' },
    ])
    const at = (event: string) => fixture.timeline.find(entry => entry.event === event)!.at
    expect(at('lease-saved-before-ack')).toBeLessThanOrEqual(at('summary-opened'))
    expect(at('summary-opened')).toBeLessThanOrEqual(at('refresh-request'))
    const waits = fixture.control.command.mock.calls.filter(([action]) => action === 'waitFor')
    for (const [selector, expected] of [
      [statusSelector, '已合并'],
      [checksSelector, '检查通过'],
      [healthSelector, '状态同步正常'],
    ])
      expect(waits).toContainEqual(['waitFor', selector, { text: expected }])
    expect(fixture.control.command).toHaveBeenCalledWith('getAttribute', statusSelector, {
      value: 'aria-label',
    })
    expect(
      fixture.control.command.mock.calls.some(
        ([, selector]) => selector === '[data-testid="change-request-state"]'
      )
    ).toBe(false)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(13_174)
    expect(result.elapsedMs).toBeLessThan(20_000)
  }
)

const invalidLeases: Array<[string, NonNullable<FixtureOptions['alterLease']>]> = [
  ['old id', (lease, old) => ({ ...lease, id: old.id })],
  ['old consumer', (lease, old) => ({ ...lease, consumer_key: old.consumer_key })],
  ['old generation', (lease, old) => ({ ...lease, generation: old.generation })],
  ['another consumer', lease => ({ ...lease, consumer_key: 'conversation-events:other' })],
  ['another Runtime', lease => ({ ...lease, device_id: 'other-runtime' })],
  ['preparing', lease => ({ ...lease, status: 'preparing' })],
  ['stopped', lease => ({ ...lease, status: 'stopped' })],
  ['error status', lease => ({ ...lease, status: 'error' })],
  ['expired', lease => ({ ...lease, expires_at: Date.now() })],
  ['missing generation', lease => ({ ...lease, generation: '' })],
  ...Object.entries({
    providerId: '@wegent/dsh-connection-git/gitlab',
    kind: 'personal',
    transport: 'webhook',
    id: '2632',
    name: 'other/repository',
    profile: '["https://github.com","other-account"]',
    monitoredObjects: [{ entityKind: 'change_request', number: 2632 }],
  }).map(([field, value]): [string, NonNullable<FixtureOptions['alterLease']>] => [
    `wrong source ${field}`,
    lease => ({ ...lease, source: { ...lease.source, [field]: value } }),
  ]),
]

test.each(invalidLeases)(
  'does not open the summary for an unacknowledged %s lease',
  async (_name, alterLease) => {
    const fixture = await recoveryFixture({ alterLease })
    const result = await finishRecovery(fixture)
    expect((result.error as Error).message).toBe(activationFailure)
    expect(fixture.timeline.some(entry => entry.event === 'summary-opened')).toBe(false)
    expect(fixture.providerReads.map(read => read.operation)).toEqual(['connection_observer_start'])
  }
)

test('rejects ambiguous new target leases', async () => {
  const fixture = await recoveryFixture({ duplicateLease: true })
  const result = await finishRecovery(fixture)
  expect((result.error as Error).message).toBe(activationFailure)
  expect(fixture.timeline.some(entry => entry.event === 'summary-opened')).toBe(false)
})

test.each([
  ['open', statusSelector],
  ['failure', checksSelector],
  ['refreshing', healthSelector],
  ['error', statusSelector],
] as const)(
  'rejects a %s provider result after the native lease is ready',
  async (outcome, selector) => {
    const fixture = await recoveryFixture({ outcome })
    const result = await finishRecovery(fixture)
    expect((result.error as Error).message).toContain(`Timed out waiting for ${selector}`)
    const waits = fixture.control.command.mock.calls.filter(([action]) => action === 'waitFor')
    expect(waits.at(-1)?.[1]).toBe(selector)
  }
)

test('keeps the ten-second native activation deadline', async () => {
  const fixture = await recoveryFixture({ startDelayMs: 10_001 })
  const result = await finishRecovery(fixture)
  expect((result.error as Error).message).toBe(activationFailure)
  expect(result.elapsedMs).toBe(10_000)
  expect(fixture.timeline.some(entry => entry.event === 'summary-opened')).toBe(false)
})

test('keeps the independent ten-second UI state deadline after activation', async () => {
  const fixture = await recoveryFixture({ refreshDelayMs: 10_001 })
  const result = await finishRecovery(fixture)
  expect((result.error as Error).message).toContain(`Timed out waiting for ${statusSelector}`)
  const opened = fixture.timeline.find(entry => entry.event === 'summary-opened')!.at
  const started = fixture.timeline.find(entry => entry.event === 'start-request')!.at
  expect(result.elapsedMs - (opened - started)).toBe(10_000)
})

test('does not enable observation if repairing its provider fixture fails', async () => {
  const fixture = await recoveryFixture()
  await expect(
    recoverChangeRequestStatus(fixture.control, {
      statePath: join(directory, 'missing', 'provider-state'),
      ...(await prepareChangeRequestRecovery(fixture.executorHome)),
      uiTimeoutMs: 10_000,
    })
  ).rejects.toThrow('ENOENT')
  expect(fixture.control.command).not.toHaveBeenCalled()
  expect(fixture.providerReads).toEqual([])
})

test('does not expose a malformed native journal in its failure', async () => {
  const fixture = await recoveryFixture()
  await writeFile(fixture.journalPath, '{"private":"synthetic-private-journal"')
  const error = await prepareChangeRequestRecovery(fixture.executorHome).catch(
    (failure: unknown) => failure
  )
  expect((error as Error).message).toBe(
    'The native change-request observer journal could not be read'
  )
  expect((error as Error).message).not.toContain('synthetic-private-journal')
  expect(error).toMatchObject({ code: 'ERR_SQLITE_ERROR', sqliteCode: 26 })
  expect(JSON.stringify(error)).not.toContain('synthetic-private-journal')
  expect(fixture.control.command).not.toHaveBeenCalled()
})

test('reads the native observer journal across a bounded WAL lock', async () => {
  vi.useRealTimers()
  const fixture = await recoveryFixture()
  const writer = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads')
     const { DatabaseSync } = require('node:sqlite')
     const db = new DatabaseSync(workerData)
     db.exec('PRAGMA journal_mode=WAL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE')
     db.prepare("UPDATE records SET value=value WHERE section='observers'").run()
     parentPort.postMessage('locked')
     parentPort.once('message', () => {
       // Hold a real lock briefly after the reader is ready to start.
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75)
       db.exec('COMMIT')
       db.close()
       parentPort.close()
     })`,
    { eval: true, workerData: fixture.journalPath }
  )
  try {
    await new Promise<void>((resolve, reject) => {
      writer.once('message', () => resolve())
      writer.once('error', reject)
    })
    const probe = new DatabaseSync(fixture.journalPath, { readOnly: true })
    try {
      expect(() => probe.prepare('SELECT * FROM records').all()).toThrow('database is locked')
    } finally {
      probe.close()
    }
    writer.postMessage('read')
    await expect(prepareChangeRequestRecovery(fixture.executorHome)).resolves.toMatchObject({
      journalPath: fixture.journalPath,
      activationCompleted: expect.any(Function),
    })
  } finally {
    await writer.terminate()
  }
})
