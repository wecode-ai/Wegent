// @vitest-environment node

import { expect, test } from 'vitest'
import {
  acknowledgedPluginGeneration,
  latestPluginSyncRequest,
} from '../e2e/desktop/modules/plugin-sync-observer.mjs'

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

const scopedRequest = (generation, otherGeneration) => ({
  ...request(generation),
  pluginIds: ['71', '72'],
  pluginSync: {
    version: 3,
    generation: Math.max(generation, otherGeneration),
    complete: false,
    revisions: { 71: generation, 72: otherGeneration },
    intentRevisions: { 71: 1, 72: 4 },
  },
})

test('orders V3 by the affected plugin even when another plugin has a higher counter', () => {
  const older = scopedRequest(2, 99)
  const current = scopedRequest(3, 4)
  const observation = {
    capabilities: [older, current],
    acknowledgements: [ack(older), ack(current)],
  }
  expect(latestPluginSyncRequest(observation.capabilities, 71)).toBe(current)
  expect(
    acknowledgedPluginGeneration(observation, { plugin_sync_generation: 3 }, 71, older)
  ).toEqual(ack(current))
})

test.each(['revisions', 'intentRevisions'])('rejects V3 ACK with mismatched %s', field => {
  const current = scopedRequest(3, 99)
  const acknowledgement = ack(current)
  acknowledgement.pluginSync = {
    ...current.pluginSync,
    [field]: { ...current.pluginSync[field], 71: 2 },
  }
  expect(
    acknowledgedPluginGeneration(
      { capabilities: [current], acknowledgements: [acknowledgement] },
      { plugin_sync_generation: 3 },
      71,
      current
    )
  ).toBeNull()
})
