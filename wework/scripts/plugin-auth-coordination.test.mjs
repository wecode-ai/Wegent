// @vitest-environment node

import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'
import {
  holdBackgroundPluginAuthRow,
  verifyPluginAuthCoordination,
} from '../e2e/desktop/modules/plugin-auth-coordination.mjs'

const fixture = vi.hoisted(() => ({
  holdFault: vi.fn(),
  holdCoordination: vi.fn(),
  holdLease: vi.fn(),
  install: vi.fn(),
  publish: vi.fn(),
}))
vi.mock('../e2e/desktop/modules/plugin-write-lease.mjs', () => ({
  holdPluginCoordinationFault: (...args) => fixture.holdCoordination(...args),
  holdInstalledPluginRow: (...args) => fixture.holdFault(...args),
  holdPluginWriteLease: (...args) => fixture.holdLease(...args),
}))
vi.mock('../e2e/desktop/modules/plugin-write-coordination.mjs', () => ({
  publishIndependentPluginReleases: (...args) => fixture.publish(...args),
  verifyIndependentPluginMutations: vi.fn(),
}))
vi.mock('../e2e/desktop/modules/plugin-regression-fixture.mjs', async importOriginal => ({
  ...(await importOriginal()),
  pluginApi: (...args) => fixture.install(...args),
}))

const reachedAuthCases = new Error('Verified baseline; stop before real fault processes')
const refresh = '[data-testid="plugins-refresh-button"]'
const deferred = () => {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  for (const mock of Object.values(fixture)) mock.mockReset()
  fixture.holdFault.mockRejectedValue(reachedAuthCases)
})

function renderer({ refreshError, diagnostic = { pluginDeviceSyncInFlight: false } } = {}) {
  const reconciliation = deferred()
  const refreshRequested = deferred()
  const diagnosticRequested = deferred()
  const syncCompletion = deferred()
  const calls = []
  let visible = true
  let completed = false
  const control = {
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'getAttribute') return '4'
      if (action === 'clickWhenEnabled' && selector === refresh) {
        refreshRequested.resolve()
        return ''
      }
      if (action === 'waitFor' && selector.includes('data-reconciliation-revision')) {
        await reconciliation.promise
        if (refreshError) throw refreshError
        completed = true
        return ''
      }
      if (action === 'click' && selector === '[data-testid="new-chat-button"]') {
        assert.equal(completed, true, 'Navigation interrupted the real reconciliation')
        visible = false
      }
      if (action === 'getWorkbenchDebugSnapshot') {
        assert.equal(visible, false, 'Plugins can still start another device sync')
        diagnosticRequested.resolve()
        await syncCompletion.promise
        return JSON.stringify(Array.isArray(diagnostic) ? diagnostic.shift() : diagnostic)
      }
      if (action === 'localConnectorAuth') return JSON.stringify({ status: 'ok' })
      return ''
    },
  }
  const context = {
    cloud: {},
    control,
    installedId: 77,
    slug: 'account-auth-fixture',
    expectedDeviceId: 'app-record-76',
    timeoutMs: 10_000,
  }
  const result = holdBackgroundPluginAuthRow(context).catch(error => error)
  return {
    calls,
    result,
    reconciliation,
    refreshRequested,
    diagnosticRequested,
    syncCompletion,
  }
}

test('auth row faults cannot capture an unfinished renderer device-sync batch', async () => {
  const run = renderer()
  await Promise.race([run.refreshRequested.promise, run.result])
  assert.equal(fixture.holdFault.mock.calls.length, 0, 'Fault preceded reconciliation')
  assert.ok(run.calls.some(call => call.action === 'clickWhenEnabled' && call.selector === refresh))
  assert.ok(!run.calls.some(call => call.action === 'localConnectorAuth'))

  run.reconciliation.resolve()
  await Promise.race([run.diagnosticRequested.promise, run.result])
  assert.equal(fixture.holdFault.mock.calls.length, 0, 'Fault captured a pending device sync')
  assert.ok(!run.calls.some(call => call.action === 'localConnectorAuth'))
  assert.ok(
    run.calls.some(
      call =>
        call.action === 'waitFor' &&
        call.selector === '[data-testid="plugins-workspace"]' &&
        call.options?.visible === false
    )
  )
  const diagnostic = run.calls.find(call => call.action === 'getWorkbenchDebugSnapshot')
  assert.equal(diagnostic.options.value, 'app-record-76')

  run.syncCompletion.resolve()
  assert.equal(await run.result, reachedAuthCases)
  assert.equal(fixture.holdFault.mock.calls.length, 1)
  assert.equal(fixture.holdFault.mock.calls[0][1], 77)
})

test('failed reconciliation cannot be accepted as an authentication baseline', async () => {
  const failure = new Error('Real reconciliation failed')
  const run = renderer({ refreshError: failure })
  run.reconciliation.resolve()
  assert.equal(await run.result, failure)
  assert.equal(fixture.holdFault.mock.calls.length, 0)
  assert.ok(!run.calls.some(call => call.action === 'localConnectorAuth'))
})

test('missing device-sync evidence cannot certify a ready authentication baseline', async () => {
  const run = renderer({ diagnostic: {} })
  run.reconciliation.resolve()
  run.syncCompletion.resolve()
  assert.match((await run.result).message, /device-sync diagnostic/)
  assert.equal(fixture.holdFault.mock.calls.length, 0)
  assert.ok(!run.calls.some(call => call.action === 'localConnectorAuth'))
})

test('an in-flight device sync must complete before the target row is locked', async () => {
  const run = renderer({
    diagnostic: [{ pluginDeviceSyncInFlight: true }, { pluginDeviceSyncInFlight: false }],
  })
  run.reconciliation.resolve()
  run.syncCompletion.resolve()
  await Promise.race([run.diagnosticRequested.promise, run.result])
  assert.equal(fixture.holdFault.mock.calls.length, 0)
  assert.equal(await run.result, reachedAuthCases)
  assert.equal(run.calls.filter(call => call.action === 'getWorkbenchDebugSnapshot').length, 2)
  assert.equal(fixture.holdFault.mock.calls.length, 1)
})

test('the real auth workflow settles inventory after publishing and installing the other plugin', async () => {
  const events = []
  let fault
  let connected = false
  const hold = mode => {
    fault = mode === 'user-row' ? undefined : mode
    return {
      async release() {
        fault = undefined
        events.push(`released:${mode}`)
      },
    }
  }
  fixture.holdCoordination.mockImplementation(async (_, mode) => hold(mode))
  fixture.holdLease.mockImplementation(async (_, id) =>
    id === 77 ? hold('lease') : { release: async () => events.push('other-lease-released') }
  )
  fixture.publish.mockImplementation(async () => {
    events.push('published-other')
    return { latest: { pluginId: 2 } }
  })
  fixture.install.mockImplementation(async () => {
    events.push('installed-other')
    return { plugin: { metadata: { labels: { id: 82 } } } }
  })
  fixture.holdFault.mockImplementation(async () => {
    events.push('held-auth-row')
    throw reachedAuthCases
  })
  const control = {
    async command(action, selector, options) {
      if (action === 'localConnectorAuth') {
        const { action: auth } = JSON.parse(options.value)
        const code = fault === 'lease' ? 'plugin_write_busy' : 'plugin_write_unavailable'
        if (auth === 'logout') {
          if (fault) throw new Error(code)
          connected = false
          return JSON.stringify({ status: 'ok' })
        }
        if (auth === 'start') return JSON.stringify({ sessionId: 'desktop-auth' })
        connected = !fault
        return JSON.stringify({ status: fault ? 'error' : 'ok', hint: fault ? code : '' })
      }
      if (action === 'getAttribute') return '4'
      if (action === 'waitFor' && selector.includes('data-reconciliation-revision')) {
        events.push('reconciled-device')
      }
      if (action === 'click' && selector === '[data-testid="new-chat-button"]') {
        events.push('left-plugins')
      }
      if (action === 'getWorkbenchDebugSnapshot') {
        events.push('device-sync-idle')
        return JSON.stringify({ pluginDeviceSyncInFlight: false })
      }
      return ''
    },
  }
  const result = await verifyPluginAuthCoordination({
    cloud: {
      queryDatabase: async () => [{ status: 'disconnected', credential_cleared: 1, grants: 0 }],
    },
    control,
    slug: 'account-auth-fixture',
    installedId: 77,
    expectedDeviceId: 'app-record-76',
    connectionFor: async () => ({
      status: connected ? 'connected' : 'disconnected',
      device_ids: ['app-record-76'],
    }),
    signalAutomaticRetry: async () => {},
    timeoutMs: 10_000,
  }).catch(error => error)
  assert.equal(result, reachedAuthCases)
  assert.deepEqual(events.slice(-7), [
    'published-other',
    'installed-other',
    'other-lease-released',
    'reconciled-device',
    'left-plugins',
    'device-sync-idle',
    'held-auth-row',
  ])
})
