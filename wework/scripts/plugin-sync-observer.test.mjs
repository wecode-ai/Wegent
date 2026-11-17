import { EventEmitter } from 'node:events'
// @vitest-environment node

import { expect, test } from 'vitest'
import {
  acknowledgedPluginGeneration,
  assertRetainedPluginUnchanged,
  latestPluginSyncRequest,
  observedRetainedPluginSync,
  observePluginSyncTransport,
} from '../e2e/desktop/modules/plugin-sync-observer.mjs'

const retainedBaseline = () => ({
  installed_plugin_id: 75,
  plugin_sync_generation: 27,
  checksum: 'sha256:retained',
  enabled: true,
  component_states: { 'skill:retained': true },
  runtime: { codex_link: '/unchanged', claude_link: '/unchanged-claude' },
  previous: null,
})
const retainedSync = () => {
  const complete = {
    at: 100,
    id: '5',
    namespace: '/local-executor,',
    deviceId: 'cloud-device',
    scope: 'plugins',
    pluginIds: ['74', '75'],
    removedIds: [],
    pluginSync: { version: 2, generation: 32, complete: true },
  }
  return { capabilities: [complete], acknowledgements: [{ ...complete, at: 110, success: true }] }
}

test('requires the matching successful ACK after manifest publication', () => {
  const baseline = retainedBaseline()
  const current = { ...baseline, plugin_sync_generation: 32 }
  const observation = retainedSync()
  const acknowledgement = observation.acknowledgements.pop()
  expect(observedRetainedPluginSync(observation, current, baseline, 'cloud-device')).toEqual({
    request: observation.capabilities[0],
    acknowledgement: undefined,
  })
  expect(() =>
    assertRetainedPluginUnchanged(current, baseline, observation, 'cloud-device')
  ).toThrow(/unrelated plugin runtime/)
  observation.acknowledgements.push(acknowledgement)
  expect(() =>
    assertRetainedPluginUnchanged(current, baseline, observation, 'cloud-device')
  ).not.toThrow()
})

test.each([undefined, '27', NaN])('rejects an unverifiable baseline generation: %s', generation => {
  const baseline = { ...retainedBaseline(), plugin_sync_generation: generation }
  const current = { ...baseline, plugin_sync_generation: 32 }
  expect(() =>
    assertRetainedPluginUnchanged(current, baseline, retainedSync(), 'cloud-device')
  ).toThrow(/unrelated plugin runtime/)
})

test.each([90, 105])(
  'accepts only the acknowledged 27-to-32 ordering change when baseline capture is %i',
  capturedAt => {
    const baseline = retainedBaseline()
    const observation = { ...retainedSync(), recoveryStartedAt: 200, capturedAt }
    expect(() =>
      assertRetainedPluginUnchanged(
        { ...baseline, plugin_sync_generation: 32 },
        baseline,
        observation,
        'cloud-device'
      )
    ).not.toThrow()
  }
)

test.each(['checksum', 'enabled', 'component_states', 'runtime', 'previous', 'unknownField'])(
  'still rejects an unrelated %s change with an acknowledged complete sync',
  field => {
    const baseline = retainedBaseline()
    const current = { ...baseline, plugin_sync_generation: 32, [field]: 'changed' }
    expect(() =>
      assertRetainedPluginUnchanged(current, baseline, retainedSync(), 'cloud-device')
    ).toThrow(/unrelated plugin runtime/)
  }
)

test.each([
  'unobserved',
  'partial',
  'missing-ack',
  'failed-ack',
  'wrong-device',
  'wrong-scope',
  'wrong-plugin',
  'removed-plugin',
  'wrong-id',
  'wrong-namespace',
  'wrong-ack-scope',
  'wrong-ack-plugin',
  'wrong-version',
  'wrong-ack-generation',
  'wrong-ack-complete',
  'ack-before-request',
  'older-generation',
])('requires complete transport evidence for an ordering change: %s', fault => {
  const baseline = retainedBaseline()
  const observation = retainedSync()
  const complete = observation.capabilities[0]
  const acknowledgement = observation.acknowledgements[0]
  if (fault === 'unobserved') observation.capabilities = []
  if (fault === 'partial') complete.pluginSync = { ...complete.pluginSync, complete: false }
  if (fault === 'missing-ack') observation.acknowledgements = []
  if (fault === 'failed-ack') acknowledgement.success = false
  if (fault === 'wrong-device') complete.deviceId = 'other-device'
  if (fault === 'wrong-scope') complete.scope = 'plugin_delta'
  if (fault === 'wrong-plugin') complete.pluginIds = ['74']
  if (fault === 'removed-plugin') complete.removedIds = ['75']
  if (fault === 'wrong-id') acknowledgement.id = 'other'
  if (fault === 'wrong-namespace') acknowledgement.namespace = '/other,'
  if (fault === 'wrong-ack-scope') acknowledgement.scope = 'plugin_delta'
  if (fault === 'wrong-ack-plugin') acknowledgement.pluginIds = ['74']
  if (fault === 'wrong-version') complete.pluginSync = { ...complete.pluginSync, version: 1 }
  if (fault === 'wrong-ack-generation')
    acknowledgement.pluginSync = { ...complete.pluginSync, generation: 33 }
  if (fault === 'wrong-ack-complete')
    acknowledgement.pluginSync = { ...complete.pluginSync, complete: false }
  if (fault === 'ack-before-request') acknowledgement.at = 99
  const current = { ...baseline, plugin_sync_generation: fault === 'older-generation' ? 26 : 32 }
  expect(() =>
    assertRetainedPluginUnchanged(current, baseline, observation, 'cloud-device')
  ).toThrow(/unrelated plugin runtime/)
})

test('keeps exact equality without sync evidence even when the generation is unchanged', () => {
  const baseline = retainedBaseline()
  const observation = { capabilities: [], acknowledgements: [] }
  expect(() =>
    assertRetainedPluginUnchanged({ ...baseline }, baseline, observation, 'cloud-device')
  ).not.toThrow()
  expect(() =>
    assertRetainedPluginUnchanged(
      { ...baseline, enabled: false },
      baseline,
      observation,
      'cloud-device'
    )
  ).toThrow(/unrelated plugin runtime/)
})

const request = (generation, id = String(generation)) => ({
  at: generation * 100,
  id,
  namespace: '/local-executor,',
  pluginIds: ['71'],
  pluginSync: { version: 2, generation, complete: generation !== 7 },
})
const ack = request => ({ ...request, at: request.at + 10, success: true })

test.each([{ order: [14, 13, 15] }, { order: [14, 15, 13] }, { order: [13, 15, 14] }])(
  'settles only the highest received generation when frames arrive as $order',
  ({ order }) => {
    const requests = order.map((generation, index) => ({
      ...request(generation),
      at: index * 100,
      pluginSync: { version: 2, generation, complete: generation === 14 },
    }))
    const observation = { capabilities: requests, acknowledgements: requests.map(ack) }
    const latest = latestPluginSyncRequest(requests)
    expect(latest.pluginSync.generation).toBe(15)
    expect(
      acknowledgedPluginGeneration(observation, { plugin_sync_generation: 15 }, 71, latest)
    ).toEqual(ack(latest))
    for (const generation of [13, 14]) {
      expect(
        acknowledgedPluginGeneration(
          observation,
          { plugin_sync_generation: generation },
          71,
          latest
        )
      ).toBeNull()
    }
  }
)

test('does not invent a latest generation before observing a request', () => {
  expect(latestPluginSyncRequest([])).toBeUndefined()
})

test('accepts the exact ACK for a current full sync superseding the setup delta', () => {
  const initial = request(7)
  const current = request(8)
  const observation = {
    capabilities: [initial, current],
    acknowledgements: [ack(initial), ack(current)],
  }
  expect(
    acknowledgedPluginGeneration(observation, { plugin_sync_generation: 8 }, 71, initial)
  ).toEqual(ack(current))
  expect(
    acknowledgedPluginGeneration(observation, { plugin_sync_generation: 7 }, 71, initial)
  ).toEqual(ack(initial))
})

test.each(['missing', 'failed', 'namespace', 'id', 'version', 'generation', 'complete', 'plugin'])(
  'rejects a %s ACK for the generation currently on disk',
  fault => {
    const initial = request(7)
    const current = request(8)
    const acknowledgement = ack(current)
    if (fault === 'failed') acknowledgement.success = false
    if (fault === 'namespace') acknowledgement.namespace = '/other,'
    if (fault === 'id') acknowledgement.id = 'other'
    if (fault === 'version') acknowledgement.pluginSync = { ...current.pluginSync, version: 1 }
    if (fault === 'generation')
      acknowledgement.pluginSync = { ...current.pluginSync, generation: 9 }
    if (fault === 'complete')
      acknowledgement.pluginSync = { ...current.pluginSync, complete: false }
    if (fault === 'plugin') acknowledgement.pluginIds = ['72']
    const observation = {
      capabilities: [initial, current],
      acknowledgements: [ack(initial), ...(fault === 'missing' ? [] : [acknowledgement])],
    }
    expect(
      acknowledgedPluginGeneration(observation, { plugin_sync_generation: 8 }, 71, initial)
    ).toBeNull()
  }
)

test('rejects unobserved, older and unrelated generations even with successful ACKs', () => {
  const initial = request(7)
  const old = request(6)
  const unrelated = { ...request(8), pluginIds: ['72'] }
  const observation = {
    capabilities: [old, initial, unrelated],
    acknowledgements: [ack(old), ack(initial), ack(unrelated)],
  }
  for (const generation of [6, 8, 9]) {
    expect(
      acknowledgedPluginGeneration(observation, { plugin_sync_generation: generation }, 71, initial)
    ).toBeNull()
  }
})

test('records a reconciliation as complete only after its HTTP response finishes', () => {
  const response = new EventEmitter()
  const proxy = {
    target: 'http://localhost',
    websockets: new Set(),
    holdNextCapabilitySync: () => ({ receive() {}, observeAcknowledgement() {} }),
    forward() {},
  }
  const observation = observePluginSyncTransport(proxy)
  proxy.forward(
    { method: 'POST', url: '/api/plugins/installed/sync-device?reconcile=true' },
    response
  )
  expect(observation.reconciliations).toHaveLength(1)
  expect(observation.reconciliations[0].completedAt).toBeUndefined()
  response.emit('finish')
  expect(observation.reconciliations[0].completedAt).toBeGreaterThanOrEqual(
    observation.reconciliations[0].at
  )
})
