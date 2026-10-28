import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  calls: [],
  contexts: [],
  proxies: [],
  storages: [],
  failGroup: null,
  apiProxy: null,
  invoke: null,
}))

vi.mock('../e2e/desktop/modules/shared.mjs', () => ({ CLOUD_DEVICE_ID: 'remote-device' }))
vi.mock('../e2e/desktop/modules/plugin-source-continuation.mjs', () => ({
  verifyPluginSourceContinuation: context => state.invoke('source-continuation', context),
}))
vi.mock('../e2e/desktop/modules/plugin-catalog-boundaries.mjs', () => ({
  verifyPluginCatalogBoundaries: context => state.invoke('catalog-sources', context),
}))
vi.mock('../e2e/desktop/modules/plugin-late-response-resilience.mjs', () => ({
  verifyPluginLateResponseResilience: context => state.invoke('late-response', context),
}))
vi.mock('../e2e/desktop/modules/plugin-detail-resilience.mjs', () => ({
  verifyPluginDetailResilience: context => state.invoke('plugin-detail', context),
}))
vi.mock('../e2e/desktop/modules/plugin-partial-inventory-resilience.mjs', () => ({
  verifyPluginPartialInventoryResilience: context => state.invoke('partial-inventory', context),
}))
vi.mock('../e2e/desktop/modules/plugin-scope-boundaries.mjs', () => ({
  verifyPluginScopeBoundaries: context => state.invoke('account-and-device', context),
}))
vi.mock('../e2e/desktop/modules/plugin-sync-disconnect.mjs', () => ({
  verifyPluginSyncDisconnect: context => state.invoke('sync-disconnect', context),
}))
vi.mock('../e2e/desktop/modules/plugin-write-coordination.mjs', () => ({
  verifyPluginWriteCoordination: context => state.invoke('write-coordination', context),
}))
vi.mock('../e2e/desktop/modules/plugin-install-update-resilience.mjs', () => ({
  verifyPluginInstallUpdateResilience: context => state.invoke('install-and-update', context),
}))
vi.mock('../e2e/desktop/modules/plugin-registration-coordination.mjs', () => ({
  verifyPluginRegistrationCoordination: () => {
    throw new Error('Unexpected registration checkpoint')
  },
}))
vi.mock('../e2e/desktop/modules/real-object-storage.mjs', () => ({
  startRealObjectStorage: async () => {
    const storage = {
      backendEnv: { ATTACHMENT_S3_ENDPOINT: 'http://127.0.0.1:9000' },
      stop: vi.fn(),
    }
    state.storages.push(storage)
    return storage
  },
}))
vi.mock('../e2e/desktop/modules/transport-fault-proxy.mjs', () => ({
  TransportFaultProxy: class {
    constructor(target, options) {
      this.target = target
      this.options = options
      this.url = `http://127.0.0.1:${30_000 + state.proxies.length}`
      this.websockets = new Set(['real-device-connection'])
      this.requests = []
      this.rule = () => null
      this.paused = false
      this.acknowledgementsPaused = false
      state.proxies.push(this)
    }
    async start() {
      return this
    }
    async stop() {
      this.stopped = true
    }
    disconnectWebSockets(value) {
      this.disconnected = value
    }
    pauseDeviceDelivery(value) {
      this.paused = value
    }
    pauseDeviceAcknowledgements(value) {
      this.acknowledgementsPaused = value
    }
  },
}))
vi.mock('../e2e/desktop/modules/plugin-regression-fixture.mjs', () => ({
  accountPlugin: async () => undefined,
  assertInstallButton: vi.fn(),
  assertInventory: vi.fn(),
  assertSurfaces: vi.fn(),
  installFixture: async () => {
    state.calls.push('seed-uninstall')
    return { installedId: 71, pluginId: 72, slug: 'original-uninstall' }
  },
  materializedPlugin: vi.fn(),
  openPlugin: vi.fn(),
  pathExists: vi.fn(),
  pluginApi: vi.fn(),
  testId: id => `[data-testid="${id}"]`,
  uninstallInUi: async () => {
    state.calls.push('uninstall')
    state.apiProxy.requests.push(
      {
        method: 'DELETE',
        path: '/api/plugins/installed/71',
        status: 204,
        committedResponseHeld: true,
      },
      { method: 'GET', path: '/api/plugins/installed', unscoped: true }
    )
  },
  until: async (read, predicate, message) => {
    const result = await read()
    assert.ok(predicate(result), message)
    return result
  },
}))

import { createDesktopScenario } from '../e2e/desktop/scenarios/plugin-uninstall-resilience.scenario.mjs'

beforeEach(() => {
  state.calls = []
  state.contexts = []
  state.proxies = []
  state.storages = []
  state.failGroup = null
  state.apiProxy = null
  state.invoke = async (name, context) => {
    state.calls.push(name)
    state.contexts.push(context)
    state.apiProxy = context.apiProxy
    assert.equal(context.apiProxy.rule({}), null, 'A previous group left an API fault active')
    assert.equal(context.deviceProxy.paused, false)
    assert.equal(context.deviceProxy.acknowledgementsPaused, false)
    if (name === 'catalog-sources') {
      assert.ok(!state.calls.includes('seed-uninstall'), 'Catalog baseline was polluted')
    }
    if (name === state.failGroup) {
      try {
        context.apiProxy.rule = () => 'disconnect'
        context.deviceProxy.pauseDeviceDelivery(true)
        context.deviceProxy.pauseDeviceAcknowledgements(true)
        throw new Error(`Failure in ${name}`)
      } finally {
        context.apiProxy.rule = () => null
        context.deviceProxy.pauseDeviceDelivery(false)
        context.deviceProxy.pauseDeviceAcknowledgements(false)
      }
    }
    return { passed: true }
  }
})

async function fixture(t, checkpoint) {
  const resultDir = await mkdtemp(join(tmpdir(), 'plugin-checkpoint-test-'))
  const scenario = await createDesktopScenario({
    checkpoint,
    resultDir,
    executorHome: join(resultDir, 'executor'),
    codexSqliteHome: join(resultDir, 'sqlite'),
    electronUserDataDirectory: join(resultDir, 'electron'),
    homePath: join(resultDir, 'home'),
    workbenchReadyTimeoutMs: 30_000,
    captureScreenshot: vi.fn(),
  })
  t.onTestFinished(async () => {
    await scenario.cleanup()
    await rm(resultDir, { recursive: true, force: true })
  })
  await scenario.prepareCloud({ backendUrl: 'http://127.0.0.1:8000' })
  const cloud = {
    backendEnv: scenario.backendEnv ?? {},
    remoteExecutorEnv: {},
    waitForConnectedAppDevice: vi.fn(async () => ({
      device_id: 'backend-device',
      app_device_id: 'renderer-device',
    })),
    restartCloudExecutor: vi.fn(),
  }
  const control = {
    command: vi.fn(async action => {
      if (action === 'getLocalExecutorStatus')
        return JSON.stringify({ deviceId: 'renderer-device' })
      assert.ok(['click', 'waitFor'].includes(action), `Unexpected action: ${action}`)
    }),
  }
  scenario.setCloudEnvironment(cloud)
  scenario.setRestartDesktopApp(vi.fn())
  return {
    scenario,
    cloud,
    control,
    evidence: async () =>
      JSON.parse(await readFile(join(resultDir, 'plugin-uninstall-evidence.json'))),
  }
}

const catalogGroups = [
  'source-continuation',
  'catalog-sources',
  'late-response',
  'plugin-detail',
  'partial-inventory',
  'account-and-device',
]

test('catalog boundaries and the original uninstall share one scenario with clean fixture order', async t => {
  const f = await fixture(t, 'plugin-uninstall-lost-response')

  await f.scenario.verify(f.control)

  expect(state.calls).toEqual([...catalogGroups, 'seed-uninstall', 'uninstall'])
  expect(state.proxies).toHaveLength(2)
  expect(state.storages).toHaveLength(0)
  expect(f.cloud.restartCloudExecutor).toHaveBeenCalledTimes(1)
  for (const context of state.contexts) {
    expect(context.cloud).toBe(f.cloud)
    expect(context.control).toBe(f.control)
    expect(context.apiProxy).toBe(state.proxies[0])
    expect(context.deviceProxy).toBe(state.proxies[1])
  }
  const { evidence } = await f.evidence()
  const phases = evidence.filter(entry => entry.group)
  expect(phases.map(entry => entry.group)).toEqual([
    ...catalogGroups,
    'committed-delete-lost-response',
  ])
  for (const phase of phases) {
    expect(Number.isFinite(phase.phaseStartedAt)).toBe(true)
    expect(phase.phaseElapsedMs).toBeGreaterThanOrEqual(0)
  }
  expect(evidence.some(entry => entry.case === 'committed-delete-lost-response')).toBe(true)
})

test('a restored catalog fault does not skip later groups or the original uninstall, and still fails', async t => {
  const f = await fixture(t, 'plugin-uninstall-lost-response')
  state.failGroup = 'partial-inventory'

  await expect(f.scenario.verify(f.control)).rejects.toBeInstanceOf(AggregateError)

  expect(state.calls).toEqual([...catalogGroups, 'seed-uninstall', 'uninstall'])
  const { evidence } = await f.evidence()
  expect(evidence.find(entry => entry.group === state.failGroup).passed).toBe(false)
  expect(evidence.some(entry => entry.case === 'committed-delete-lost-response')).toBe(true)
})

test('install/update cases reuse the write-coordination cloud, MinIO and all existing proxies', async t => {
  const f = await fixture(t, 'plugin-write-coordination')

  await f.scenario.verify(f.control)

  expect(state.calls).toEqual(['sync-disconnect', 'write-coordination', 'install-and-update'])
  expect(state.storages).toHaveLength(1)
  expect(state.proxies).toHaveLength(3)
  expect(f.cloud.restartCloudExecutor).toHaveBeenCalledTimes(1)
  expect(f.cloud.backendEnv.ATTACHMENT_S3_ENDPOINT).toBe(state.proxies[0].url)
  for (const context of state.contexts) {
    expect(context.cloud).toBe(f.cloud)
    expect(context.control).toBe(f.control)
    expect(context.packageProxy).toBe(state.proxies[0])
    expect(context.apiProxy).toBe(state.proxies[1])
    expect(context.deviceProxy).toBe(state.proxies[2])
    expect(context.localDeviceId).toBe('backend-device')
    expect(context.deviceId).toBe('renderer-device')
  }
})

for (const name of ['sync-disconnect', 'write-coordination']) {
  test(`a restored ${name} fault does not skip the remaining checks or hide failure`, async t => {
    const f = await fixture(t, 'plugin-write-coordination')
    state.failGroup = name

    await expect(f.scenario.verify(f.control)).rejects.toBeInstanceOf(AggregateError)

    expect(state.calls).toEqual(['sync-disconnect', 'write-coordination', 'install-and-update'])
    const { evidence } = await f.evidence()
    expect(evidence.find(entry => entry.group === name).passed).toBe(false)
    expect(evidence.find(entry => entry.group === 'install-and-update').passed).toBe(true)
  })
}
