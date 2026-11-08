// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { loadDesktopCheckpointCatalog } from '../../e2e/desktop/checkpoint-catalog.mjs'
import { expandDesktopCheckpoints } from '../../e2e/desktop/checkpoints.mjs'
import {
  assertIdleExecutorTraffic,
  summarizeExecutorTraffic,
} from '../../e2e/desktop/modules/idle-executor-requests.mjs'

const windows = [
  { name: 'foreground', start: 1000, end: 7500 },
  { name: 'background', start: 8000, end: 14500 },
]
const row = (method: string, at = 500, extra: Record<string, unknown> = {}) => ({
  method,
  at,
  status: 200,
  failed: false,
  pendingOnly: false,
  preferCached: false,
  ...extra,
})
const fixture = () => [
  row('runtime.worktrees.capabilities'),
  row('runtime.stand_in.telemetry.configure', 500, { consentEnabled: false }),
  row('executor.events'),
  ...windows.flatMap(window => [
    row('executor.describe', window.start + 100),
    row('runtime.tasks.list', window.start + 200, { pendingOnly: true, preferCached: true }),
  ]),
]

test('real traffic summary excludes pre-navigation requests and never retains secrets', () => {
  const request = (
    requestId: string,
    timestamp: number,
    path: string,
    extra: Record<string, unknown> = {}
  ) => ({
    method: 'Network.requestWillBeSent',
    timestamp,
    params: {
      requestId,
      request: { url: `http://localhost${path}?token=secret`, ...extra },
    },
  })
  const events = [
    request('old', 1, '/wework/executor/v1'),
    { ...request('nav', 2, '/'), params: { ...request('nav', 2, '/').params, type: 'Document' } },
    request('rpc', 3, '/wework/executor/v1/rpc', {
      headers: { Authorization: 'secret' },
      postData: JSON.stringify({
        method: 'runtime.tasks.list',
        params: { pendingOnly: true, preferCached: true, token: 'secret', content: 'private' },
      }),
    }),
    { method: 'Network.responseReceived', params: { requestId: 'rpc', response: { status: 200 } } },
    request('describe', 4, '/wework/executor/v1'),
    { method: 'Network.loadingFailed', params: { requestId: 'describe' } },
  ]
  assert.deepEqual(summarizeExecutorTraffic(events), [
    row('runtime.tasks.list', 3, { pendingOnly: true, preferCached: true }),
    row('executor.describe', 4, { status: undefined, failed: true }),
  ])
  assert.doesNotMatch(
    JSON.stringify(summarizeExecutorTraffic(events)),
    /secret|private|token|headers/
  )
  assert.throws(() => summarizeExecutorTraffic([]), /not reloaded/)
})

test('idle contract retains pending discovery and identity fences in both native window states', () => {
  assertIdleExecutorTraffic(fixture(), windows)
  assertIdleExecutorTraffic([...fixture(), row('runtime.codex.models.list', 1200)], windows)
})

test('malformed RPCs and unclassified routes fail without printing request contents', () => {
  const navigation = {
    method: 'Network.requestWillBeSent',
    timestamp: 1,
    params: { type: 'Document', request: { url: 'http://localhost/wework/app/' } },
  }
  for (const [path, postData, expected] of [
    ['/rpc', 'private-invalid-json', /not valid JSON/],
    ['/rpc', '{}', /method is missing/],
    ['/unknown?token=private', undefined, /Unexpected Executor route/],
  ] as const) {
    assert.throws(
      () =>
        summarizeExecutorTraffic([
          navigation,
          {
            method: 'Network.requestWillBeSent',
            timestamp: 2,
            params: {
              requestId: 'rpc',
              request: { url: `http://localhost/wework/executor/v1${path}`, postData },
            },
          },
        ]),
      error =>
        error instanceof Error && expected.test(error.message) && !error.message.includes('private')
    )
  }
})

for (const method of [
  'runtime.worktrees.capabilities',
  'runtime.stand_in.telemetry.configure',
  'executor.events',
]) {
  test(`idle contract rejects duplicate ${method}`, () => {
    assert.throws(() => assertIdleExecutorTraffic([...fixture(), row(method, 1200)], windows))
  })
}

test('idle contract rejects full catalogs, unknown task work, failures and missing discovery', () => {
  for (const extra of [
    row('runtime.tasks.list', 1200),
    row('runtime.tasks.create', 1200),
    row('executor.describe', 1200, { status: 500 }),
    row('executor.describe', 1200, { failed: true }),
  ])
    assert.throws(() => assertIdleExecutorTraffic([...fixture(), extra], windows))
  assert.throws(
    () =>
      assertIdleExecutorTraffic(
        fixture().filter(item => item.method !== 'runtime.tasks.list'),
        windows
      ),
    /stopped pending-interaction discovery/
  )
  assert.throws(
    () => assertIdleExecutorTraffic(fixture(), [{ ...windows[0], end: 2000 }]),
    /did not cross a poll interval/
  )
})

test('idle checkpoint is standalone and selected by the existing CI shard and source routing', () => {
  const id = 'idle-executor-requests'
  const catalog = loadDesktopCheckpointCatalog()
  assert.ok(catalog.DESKTOP_CHECKPOINTS.includes(id))
  assert.ok(catalog.SCENARIO_ONLY_CHECKPOINTS.has(id))
  assert.equal(catalog.CHECKPOINT_SCENARIO_MODULES[id], `./scenarios/${id}.scenario.mjs`)
  assert.deepEqual(expandDesktopCheckpoints([id]), [id])
  assert.ok(catalog.ci.core_segments.includes(id))
  assert.equal(catalog.ci.core_shards.filter(shard => shard.split(',').includes(id)).length, 1)
  for (const path of [
    'wework/src/desktop/localExecutor*',
    'wework/src/telemetry/StandInTelemetryAgent*',
    'wework/src/features/workbench/useWorkbenchDataRefresh*',
  ])
    assert.ok(catalog.PATH_TARGETS.get(path).includes(`core:${id}`))
})

test('idle fixture reuses the common first-run consent flow', async () => {
  const { createDesktopScenario } =
    await import('../../e2e/desktop/scenarios/idle-executor-requests.scenario.mjs')
  const scenario = createDesktopScenario({ resultDir: '/unused', uiTimeoutMs: 10_000 })
  assert.equal(scenario.prepareApp, undefined)
  assert.equal(scenario.appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL, '')
  assert.equal(scenario.appEnvironment.WEWORK_E2E_SEED_LOCAL_MODELS, 'false')
  assert.equal(typeof scenario.verify, 'function')
})
