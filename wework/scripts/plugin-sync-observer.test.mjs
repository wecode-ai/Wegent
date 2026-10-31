import { expect, test } from 'vitest'
import { acknowledgedPluginGeneration } from '../e2e/desktop/modules/plugin-sync-observer.mjs'

const request = (generation, id = String(generation)) => ({
  at: generation * 100,
  id,
  namespace: '/local-executor,',
  pluginIds: ['71'],
  pluginSync: { version: 2, generation, complete: generation !== 7 },
})
const ack = request => ({ ...request, at: request.at + 10, success: true })

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
