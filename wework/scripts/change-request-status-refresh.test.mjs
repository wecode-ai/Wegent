// @vitest-environment node

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/change-request-status.scenario.mjs'
import { ChangeRequestUiObserver } from '../src/features/workbench/changeRequestUiObserver'
import { createConnectionObserverFixture } from '../src/test/connection-observer'

const fixture = vi.hoisted(() => ({ log: '', state: 'pending', writes: [], observers: {} }))

vi.mock('@/api/changeRequests', () => ({
  linkedChangeRequestTarget: (deviceId, changeRequestUrl) => ({
    deviceId,
    changeRequestUrl,
    remoteUrl: 'https://github.com/wecode-ai/Wegent',
  }),
  observedChangeRequest: (_provider, data) => ({ ...data, state: data.state.toLowerCase() }),
}))
vi.mock('@/api/environment', () => ({
  outputAsRecord: value => (value && typeof value === 'object' ? value : null),
}))
vi.mock(
  '@/features/workbench/resourceObservation',
  async () => import('../src/features/workbench/resourceObservation')
)

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal()),
  execFile: vi.fn((...args) => args.at(-1)(null, '', '')),
}))
vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal()),
  chmod: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  symlink: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(async path => {
    if (path.endsWith('executor.log')) return fixture.log
    if (path.endsWith('conversation-event-subscriptions.json'))
      return JSON.stringify({ observers: fixture.observers })
    return '1\n'
  }),
  writeFile: vi.fn(async (path, value) => {
    if (path.endsWith('.wework-change-request-e2e-state')) {
      fixture.state = value.trim()
      fixture.writes.push({ state: fixture.state, at: Date.now() })
    }
  }),
}))
vi.mock('node:sqlite', () => ({
  DatabaseSync: class {
    exec() {}

    prepare() {
      return {
        all: () =>
          Object.entries(fixture.observers).map(([id, observer]) => ({
            id,
            value: JSON.stringify(observer),
          })),
      }
    }

    close() {}
  },
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
const CHANGE_REQUEST = '[data-testid="change-request-button"]'
const CHANGE_REQUEST_SOURCE = {
  providerId: '@wegent/dsh-connection-git/github',
  kind: 'repository',
  transport: 'cli',
  profile: JSON.stringify(['https://github.com', '1']),
  id: '2630',
  name: 'wecode-ai/Wegent',
  monitoredObjects: [{ entityKind: 'change_request', number: 2631 }],
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.stubEnv('PATH', process.env.PATH)
  fixture.log = ''
  fixture.state = 'pending'
  fixture.writes = []
  fixture.observers = {}
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
      'pending',
      'failure',
      'failure',
      'success',
      'unavailable',
    ])
    expect(run.runtime.operations[0].requestedAt).toBe(0)
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

test.each([true, false])(
  'restores the provider before reopening a released observation lease with initial open=%s',
  async initiallyOpen => {
    const run = await startVerification({
      initiallyOpen,
      stopAt: 'recovered',
      productionObserver: true,
    })
    await vi.advanceTimersByTimeAsync(100_000)
    expect(await run.result).toBe(run.stopAfterPhase)
    const starts = run.runtime.operations.filter(
      operation => operation.command === 'connection_observer_start'
    )
    expect(starts).toHaveLength(2)
    expect(starts.at(-1)).toMatchObject({ state: 'merged', ok: true })
    expect(starts.some(operation => operation.state === 'unavailable')).toBe(false)
    expect(fixture.writes.at(-1).at).toBeLessThanOrEqual(starts.at(-1).finishedAt - 250)
    expect(run.runtime.operations.at(-1)).toMatchObject({
      command: 'connection_observer_refresh',
      state: 'merged',
      ok: true,
    })
    expect(run.runtime.latest).toMatchObject({ changeRequest: { number: 2631, state: 'merged' } })
    expect(fixture.writes.map(write => write.state)).toEqual([
      'pending',
      'failure',
      'success',
      'unavailable',
      'merged',
    ])
    expect(run.control.checks.at(-1)).toMatchObject({
      text: '检查通过',
      timeoutMs: 10_000,
      pending: 0,
    })
  }
)

async function startVerification(options = {}) {
  const stopAfterPhase = new Error('The unchanged settings flow starts after this phase')
  const scenario = await createDesktopScenario({
    // Retain the observed repair/screenshot interleaving without a real UI or filesystem.
    captureScreenshot: vi.fn(async () => delay(500)),
    homePath: join(tmpdir(), 'change-request-status-home'),
    executorHome: join(tmpdir(), 'change-request-status-executor'),
    resultDir: join(tmpdir(), 'change-request-status-results'),
    workspacePath: join(tmpdir(), 'change-request-status-workspace'),
    uiTimeoutMs: 10_000,
    runtimeOperationTimeoutMs: 30_000,
  })
  const runtime = options.productionObserver
    ? nativeObservationLease()
    : queuedNativeRefreshes(options)
  const syncGitAccounts = async () => {
    const request = Readable.from([JSON.stringify({ allow_empty: false })])
    request.method = 'PUT'
    request.headers = { authorization: 'Bearer wework-desktop-e2e-cloud-token' }
    await scenario.handleHttp(
      request,
      { writeHead() {}, end() {} },
      new URL('http://fixture/api/devices/desktop-e2e-git-target/git-accounts')
    )
  }
  const control = baseControl(runtime, { ...options, stopAfterPhase, syncGitAccounts })
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

function nativeObservationLease() {
  const target = {
    deviceId: 'fixture-device',
    changeRequestUrl: 'https://github.com/wecode-ai/Wegent/pull/2631',
  }
  const reply = createConnectionObserverFixture()
  const operations = []
  const observer = new ChangeRequestUiObserver({
    async executeCommand(_device, request) {
      const input = JSON.parse(request.args[0])
      const leaseId = `observer-${input.consumerKey}-${input.generation}`
      const lease = {
        id: leaseId,
        consumer_key: input.consumerKey,
        generation: input.generation,
        device_id: target.deviceId,
        source: CHANGE_REQUEST_SOURCE,
        status: 'preparing',
        expires_at: Date.now() + 90_000,
      }
      if (request.command_key === 'connection_observer_start') fixture.observers[leaseId] = lease
      const operation = {
        id: `native-${operations.length + 1}`,
        command: request.command_key,
        state: fixture.state,
      }
      operations.push(operation)
      fixture.log += observationLog('started', operation)
      await delay(250)
      operation.ok = !(
        operation.command === 'connection_observer_start' && operation.state === 'unavailable'
      )
      operation.finishedAt = Date.now()
      fixture.log += observationLog('finished', operation)
      if (request.command_key === 'connection_observer_start')
        lease.status = operation.ok ? 'observing' : 'error'
      if (request.command_key === 'connection_observer_stop' && fixture.observers[leaseId])
        fixture.observers[leaseId].status = 'stopped'
      if (!operation.ok)
        throw Object.assign(new Error('Git CLI is unavailable'), { code: 'git_cli_missing' })
      const result = reply(request)
      if (operation.command !== 'connection_observer_stop') {
        result.stdout.observation.refreshPending = false
        result.stdout.observation.errorCode =
          operation.state === 'unavailable' ? 'git_cli_missing' : null
        result.stdout.observation.resourceStates[0].data.state =
          operation.state === 'merged' ? 'MERGED' : 'OPEN'
      }
      return result
    },
  })
  const runtime = {
    operations,
    get pending() {
      return operations.filter(operation => operation.finishedAt === undefined).length
    },
    async initialize() {
      observer.synchronize([target])
      runtime.latest = await observer.read(target, false)
    },
    refresh() {
      void observer.read(target, true).then(snapshot => {
        runtime.latest = snapshot
      })
    },
    setEnabled(enabled) {
      observer.synchronize(enabled ? [target] : [])
      if (enabled)
        void observer.read(target, false).then(snapshot => {
          runtime.latest = snapshot
        })
    },
  }
  return runtime
}

function observationLog(stage, operation) {
  return `app IPC request ${stage} request_id=${operation.id} method=device.execute_command command_key=${operation.command}${stage === 'finished' ? ` elapsed_ms=250 ok=${operation.ok}` : ''}\n`
}

function baseControl(
  runtime,
  { initiallyOpen = true, stopAt, domError, stopAfterPhase, syncGitAccounts }
) {
  let open = initiallyOpen
  let enabled = true
  const checks = []
  const control = {
    checks,
    command: vi.fn(async (action, selector, options = {}) => {
      if (
        action === 'fill' &&
        options.value === 'Inspect the pull request status for this branch'
      ) {
        if (runtime.initialize) await runtime.initialize()
        else {
          fixture.observers['observer-queued'] = {
            id: 'observer-queued',
            consumer_key: 'change-request-ui:queued',
            generation: 'queued',
            device_id: 'fixture-device',
            source: CHANGE_REQUEST_SOURCE,
            status: 'observing',
            expires_at: Date.now() + 90_000,
          }
          fixture.log +=
            'app IPC request started command_key=connection_observer_start\n' +
            'app IPC request finished command_key=connection_observer_start ok=true\n' +
            ipcLog('started', 'old') +
            ipcLog('finished', 'old')
        }
      }
      if (action === 'click' && selector === ENVIRONMENT) {
        open = !open
        if (open) runtime.refresh()
      }
      if (action === 'getElementCount') {
        if (selector.endsWith('option[value="desktop-e2e-git-target"]')) return 1
        return selector === '[data-testid="environment-info-popover"]' && open ? 1 : 0
      }
      if (action === 'getWorkbenchDebugSnapshot') {
        return JSON.stringify({ workbench: { currentRuntimeTask: { taskId: 'fixture-task' } } })
      }
      if (action === 'getAttribute')
        return selector === '[data-testid="change-request-status-switch"]'
          ? String(enabled)
          : selector === CHANGE_REQUEST && fixture.state === 'merged'
            ? '#2631 已合并'
            : '#2631 检查中'
      if (action === 'getText') return 'feat(wework): show pull request status'
      if (action === 'click' && selector === '[data-testid="change-request-open-settings"]')
        open = false
      if (action === 'click' && selector === '[data-testid="change-request-status-switch"]') {
        enabled = !enabled
        runtime.setEnabled?.(enabled)
      }
      if (action === 'clickWhenEnabled' && selector === '[data-testid="git-device-sync-submit"]')
        await syncGitAccounts()
      if (action === 'waitFor' && selector === CHECKS) {
        const deadline = Date.now() + (options.timeoutMs ?? 10_000)
        while (runtime.pending && Date.now() < deadline) await delay(100)
        expect(runtime.pending, 'The original UI step must settle within its budget').toBe(0)
        checks.push({
          text: options.text,
          timeoutMs: options.timeoutMs ?? 10_000,
          pending: runtime.pending,
        })
        if (options.text === '检查通过' && domError) throw domError
        if (options.text === '检查中' && stopAt === 'pending') throw stopAfterPhase
        if (fixture.state === 'merged' && stopAt === 'recovered') throw stopAfterPhase
      }
      if (action === 'waitFor' && selector === '[data-testid="change-request-lookup-hint"]') {
        control.lookupHint = { options, pending: runtime.pending }
        if (stopAt !== 'recovered') throw stopAfterPhase
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
