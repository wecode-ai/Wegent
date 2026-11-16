// @vitest-environment node

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { beforeEach, onTestFinished, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  existingVerify: vi.fn(),
  notificationCleanup: vi.fn(),
  proxyStop: vi.fn(),
  existingCleanup: vi.fn(),
  disconnected: false,
}))

vi.mock('../e2e/desktop/modules/runtime-notification-reconnect.mjs', () => ({
  createRuntimeNotificationReconnect: () => ({
    handleHttp: async () => false,
    verify: async () => {},
    cleanup: state.notificationCleanup,
  }),
}))

vi.mock('../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal()),
  fetchJson: state.fetchJson,
}))
vi.mock('../e2e/desktop/scenarios/cloud-model-recovery.scenario.mjs', () => ({
  createDesktopScenario: () => ({
    prepareCloud: async () => {},
    setCloudEnvironment: () => {},
    verify: state.existingVerify,
    cleanup: state.existingCleanup,
  }),
}))
vi.mock('../e2e/desktop/modules/transport-fault-proxy.mjs', () => ({
  TransportFaultProxy: class {
    url = 'http://fault-proxy'
    websockets = new Set(['renderer'])
    async start() {
      return this
    }
    disconnectWebSockets(value) {
      state.disconnected = value
    }
    stop = state.proxyStop
  },
}))

import { createDesktopScenario } from '../e2e/desktop/scenarios/cloud-runtime-recovery.scenario.mjs'

beforeEach(() => {
  vi.clearAllMocks()
  for (const cleanup of [state.notificationCleanup, state.proxyStop, state.existingCleanup]) {
    cleanup.mockReset()
  }
  state.disconnected = false
})

test('cleanup releases every owner and preserves each cleanup failure', async () => {
  const scenario = createDesktopScenario({ modelResponseTimeoutMs: 1000, uiTimeoutMs: 1000 })
  await scenario.prepareCloud({ backendUrl: 'http://backend' })
  const errors = [
    new Error('notification cleanup'),
    new Error('proxy cleanup'),
    new Error('base cleanup'),
  ]
  for (const [index, cleanup] of [
    state.notificationCleanup,
    state.proxyStop,
    state.existingCleanup,
  ].entries()) {
    cleanup.mockRejectedValue(errors[index])
  }
  await assert.rejects(scenario.cleanup(), error => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, errors)
    return true
  })
  for (const cleanup of [state.notificationCleanup, state.proxyStop, state.existingCleanup]) {
    assert.equal(cleanup.mock.calls.length, 1)
  }
})

async function fixture(
  summary,
  { assistantCount = 1, completedCopies = 1, userMessageCount = 1 } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'cloud-recovery-scenario-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const scenario = createDesktopScenario({ modelResponseTimeoutMs: 1000, uiTimeoutMs: 1000 })
  const cloud = {
    backendUrl: 'http://backend',
    authToken: 'isolated-test-token',
    runtimeWorkspaceRoot: root,
    waitForRuntimeTask: vi.fn(async address => {
      assert.equal(state.disconnected, true, 'Completion must be observed while disconnected')
      assert.equal(modelFinished, true)
      return { ...address, ...summary }
    }),
  }
  state.fetchJson.mockImplementation(async (url, options) => {
    if (url.includes('/api/teams?')) return { items: [{ id: 1 }] }
    assert.ok(url.endsWith('/api/runtime-work/create'))
    return { accepted: true, taskId: 'cloud-task', ...JSON.parse(options.body) }
  })
  await scenario.prepareCloud(cloud)
  scenario.setCloudEnvironment(cloud)
  onTestFinished(() => scenario.cleanup())

  let modelFinished = false
  const completed = 'CLOUD_STREAM_PARTIAL_COMPLETED_WHILE_DISCONNECTED'
  const control = {
    readyCount: 1,
    command: vi.fn(async (command, selector, options) => {
      if (command === 'navigate') {
        const request = Readable.from([
          JSON.stringify({ input: 'WEWORK_E2E_CLOUD_STREAM_RECOVERY' }),
        ])
        request.method = 'POST'
        request.headers = {}
        const response = {
          writeHead: vi.fn(),
          write: vi.fn(),
          end: () => {
            modelFinished = true
          },
        }
        assert.equal(
          await scenario.handleHttp(request, response, new URL('http://model/v1/responses')),
          true
        )
      }
      if (command === 'getText') {
        if (state.disconnected) return 'CLOUD_STREAM_PARTIAL'
        // The whole workbench also retains the turn-navigation response preview.
        return selector.includes('message-assistant')
          ? completed.repeat(completedCopies)
          : `${completed}\n${completed}`
      }
      if (command === 'getElementCount') {
        if (selector.includes('message-assistant')) return String(assistantCount)
        assert.equal(
          selector,
          '[data-testid="desktop-workbench-main"] [data-testid="message-user"]'
        )
        return String(userMessageCount)
      }
      if (command === 'getWorkbenchDebugSnapshot') {
        return JSON.stringify({
          pane: {
            currentRuntimeTask: { taskId: 'cloud-task' },
            status: { isBusy: false },
            transcript: { loading: false },
          },
        })
      }
      if (command === 'waitFor' && options?.text === completed) {
        assert.equal(state.disconnected, false)
      }
    }),
  }
  return { scenario, control, cloud }
}

test('accepts the completed runtime-work list projection without native executionState', async () => {
  const { scenario, control, cloud } = await fixture({ status: 'done', running: false })
  await scenario.verify(control)
  assert.equal(state.existingVerify.mock.calls.length, 1)
  assert.equal(cloud.waitForRuntimeTask.mock.calls.length, 1)
  assert.ok(control.command.mock.calls.some(([command]) => command === 'getWorkbenchDebugSnapshot'))
  assert.equal(state.disconnected, false)
})

test.each([{ assistantCount: 2 }, { completedCopies: 2 }])(
  'rejects a duplicated assistant node or repeated completed answer: %j',
  async duplicates => {
    const { scenario, control } = await fixture({ status: 'done', running: false }, duplicates)
    await assert.rejects(scenario.verify(control), assert.AssertionError)
    assert.equal(state.disconnected, false, 'Failure cleanup must restore the proxy')
  }
)

test.each([
  { status: 'running', running: true },
  { status: 'queued', running: false },
  { status: 'failed', running: false },
  { status: 'cancelled', running: false },
  { status: 'done', running: true },
])('rejects a cloud task that did not complete successfully: %j', async summary => {
  const { scenario, control } = await fixture(summary)
  await assert.rejects(scenario.verify(control), assert.AssertionError)
  assert.equal(state.disconnected, false, 'Failure cleanup must restore the proxy')
})

test.each([0, 2])('rejects recovery with %i original user messages', async count => {
  const { scenario, control } = await fixture(
    { status: 'done', running: false },
    { userMessageCount: count }
  )
  await assert.rejects(scenario.verify(control), /Recovery duplicated the original user message/)
  assert.equal(state.disconnected, false, 'Failure cleanup must restore the proxy')
})
