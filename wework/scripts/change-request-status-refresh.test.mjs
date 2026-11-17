// @vitest-environment node

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/change-request-status.scenario.mjs'

const fixture = vi.hoisted(() => ({ log: '', state: 'pending', writes: [] }))

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal()),
  execFile: vi.fn((...args) => args.at(-1)(null, '', '')),
}))
vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal()),
  chmod: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(async path => (path.endsWith('executor.log') ? fixture.log : '1\n')),
  writeFile: vi.fn(async (path, value) => {
    if (path.endsWith('.wework-change-request-e2e-state')) {
      fixture.state = value.trim()
      fixture.writes.push({ state: fixture.state, at: Date.now() })
    }
  }),
}))
vi.mock('../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal()),
  selectE2EModel: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({
  requestExecutor: vi.fn(async () => ({
    success: true,
    task: {
      gitInfo: {
        currentBranch: 'feature/change-request-status',
        originUrl: 'https://github.com/wecode-ai/Wegent.git',
      },
    },
  })),
}))

const ENVIRONMENT = '[data-testid="environment-info-button"]'
const CHECKS = '[data-testid="change-request-checks"]'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.stubEnv('PATH', process.env.PATH)
  fixture.log = ''
  fixture.state = 'pending'
  fixture.writes = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

test.each([true, false])(
  'serializes actual base opens and state transitions with initial open=%s',
  async initiallyOpen => {
    const run = await startVerification({ initiallyOpen })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await run.result).toBe(run.stopAfterPhase)
    expect(run.runtime.operations.map(operation => operation.state)).toEqual([
      'pending',
      'failure',
      'failure',
      'success',
      'unavailable',
    ])
    expect(run.runtime.operations[0].requestedAt).toBeGreaterThanOrEqual(500)
    for (let index = 1; index < run.runtime.operations.length; index += 1) {
      expect(run.runtime.operations[index].requestedAt).toBeGreaterThanOrEqual(
        run.runtime.operations[index - 1].finishedAt
      )
    }
    for (const write of fixture.writes.slice(1)) {
      const previous = run.runtime.operations.filter(operation => operation.requestedAt < write.at)
      expect(previous.at(-1).finishedAt).toBeLessThanOrEqual(write.at)
    }
    expect(run.control.checks.map(check => check.text)).toEqual(['检查中', '检查失败', '检查通过'])
    expect(run.control.checks.every(check => check.timeoutMs === 10_000)).toBe(true)
    expect(run.control.checks.every(check => check.pending === 0)).toBe(true)
    expect(fixture.writes.map(write => write.state)).toEqual([
      'pending',
      'failure',
      'success',
      'unavailable',
    ])
  }
)

test('old and foreign completion cannot unlock the first synchronized base open', async () => {
  const run = await startVerification({ latencyMs: 11_340, stopAt: 'pending' })
  await vi.advanceTimersByTimeAsync(10_000)
  fixture.log +=
    ipcLog('finished', 'old') + ipcLog('started', 'foreign') + ipcLog('finished', 'foreign')
  await vi.advanceTimersByTimeAsync(500)
  expect(run.control.checks).toEqual([])
  await vi.advanceTimersByTimeAsync(2_000)
  expect(await run.result).toBe(run.stopAfterPhase)
  expect(run.control.checks).toEqual([
    expect.objectContaining({ text: '检查中', timeoutMs: 10_000, pending: 0 }),
  ])
})

test('unavailable collection is an acknowledged envelope before its original error UI assertion', async () => {
  const run = await startVerification()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await run.result).toBe(run.stopAfterPhase)
  expect(run.runtime.operations.at(-1)).toMatchObject({
    state: 'unavailable',
    businessError: 'git_cli_missing',
    ok: true,
  })
  expect(run.control.lookupHint.pending).toBe(0)
  expect(run.control.lookupHint.options).toEqual({ text: '安装 GitHub CLI' })
})

test('preserves the original DOM error after the base success refresh finishes', async () => {
  const domError = new Error('The checks-passed DOM did not update')
  const run = await startVerification({ domError })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await run.result).toBe(domError)
  expect(run.control.checks.at(-1)).toMatchObject({
    text: '检查通过',
    timeoutMs: 10_000,
    pending: 0,
  })
})

test('does not enter original DOM assertions when the native envelope fails', async () => {
  const run = await startVerification({ ok: false })
  await vi.advanceTimersByTimeAsync(15_000)
  expect(await run.result).toMatchObject({
    code: 'ERR_ASSERTION',
    actual: 'false',
    expected: 'true',
  })
  expect(run.control.checks).toEqual([])
})

async function startVerification(options = {}) {
  const stopAfterPhase = new Error('The unchanged settings flow starts after this phase')
  const scenario = await createDesktopScenario({
    // Retain the observed repair/screenshot interleaving without a real UI or filesystem.
    captureScreenshot: vi.fn(async () => delay(500)),
    homePath: join(tmpdir(), 'change-request-status-home'),
    resultDir: join(tmpdir(), 'change-request-status-results'),
    workspacePath: join(tmpdir(), 'change-request-status-workspace'),
    uiTimeoutMs: 10_000,
    runtimeOperationTimeoutMs: 30_000,
  })
  const runtime = queuedNativeRefreshes(options)
  const control = baseControl(runtime, { ...options, stopAfterPhase })
  const result = scenario.verify(control).catch(error => error)
  await vi.advanceTimersByTimeAsync(0)
  return { result, control, runtime, stopAfterPhase }
}

function queuedNativeRefreshes({ latencyMs = 9_000, ok = true }) {
  const operations = []
  let queue = Promise.resolve()
  return {
    operations,
    get pending() {
      return operations.filter(operation => operation.finishedAt === undefined).length
    },
    refresh() {
      const operation = { id: `refresh-${operations.length + 1}`, requestedAt: Date.now(), ok }
      operations.push(operation)
      // Manual refresh waits for the previous monitor/observer promise, then forces collection.
      queue = queue.then(async () => {
        operation.startedAt = Date.now()
        fixture.log += ipcLog('started', operation.id)
        await delay(250)
        operation.state = fixture.state
        operation.businessError = fixture.state === 'unavailable' ? 'git_cli_missing' : null
        await delay(latencyMs - 250)
        operation.finishedAt = Date.now()
        fixture.log += ipcLog('finished', operation.id, ok)
      })
    },
  }
}

function baseControl(runtime, { initiallyOpen = true, stopAt, domError, stopAfterPhase }) {
  let open = initiallyOpen
  const checks = []
  const control = {
    checks,
    command: vi.fn(async (action, selector, options = {}) => {
      if (
        action === 'fill' &&
        options.value === 'Inspect the pull request status for this branch'
      ) {
        fixture.log +=
          'app IPC request started command_key=connection_observer_start\n' +
          'app IPC request finished command_key=connection_observer_start ok=true\n' +
          ipcLog('started', 'old') +
          ipcLog('finished', 'old')
      }
      if (action === 'click' && selector === ENVIRONMENT) {
        open = !open
        if (open) runtime.refresh()
      }
      if (action === 'getElementCount') {
        return selector === '[data-testid="environment-info-popover"]' && open ? 1 : 0
      }
      if (action === 'getWorkbenchDebugSnapshot') {
        return JSON.stringify({ workbench: { currentRuntimeTask: { taskId: 'fixture-task' } } })
      }
      if (action === 'getAttribute') return '#2631 检查中'
      if (action === 'getText') return 'feat(wework): show pull request status'
      if (action === 'waitFor' && selector === CHECKS) {
        checks.push({
          text: options.text,
          timeoutMs: options.timeoutMs ?? 10_000,
          pending: runtime.pending,
        })
        if (options.text === '检查通过' && domError) throw domError
        if (options.text === '检查中' && stopAt === 'pending') throw stopAfterPhase
      }
      if (action === 'waitFor' && selector === '[data-testid="change-request-lookup-hint"]') {
        control.lookupHint = { options, pending: runtime.pending }
        throw stopAfterPhase
      }
      return ''
    }),
  }
  return control
}

function ipcLog(stage, id, ok = true) {
  return `app IPC request ${stage} request_id=${id} method=device.execute_command command_key=connection_observer_refresh${stage === 'finished' ? ` elapsed_ms=9000 ok=${ok}` : ''}\n`
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
