import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-memory-image.scenario.mjs'
import {
  IMAGE_BYTES,
  IMAGE_HASH,
  imageRecallRole,
} from '../e2e/desktop/modules/stand-in-memory-image.mjs'

test('image memory checkpoint is independently runnable and registered once in core CI', () => {
  const catalog = loadDesktopCheckpointCatalog()
  const name = 'stand-in-memory-image'
  assert.ok(catalog.DESKTOP_CHECKPOINTS.includes(name))
  assert.ok(catalog.SCENARIO_ONLY_CHECKPOINTS.has(name))
  assert.ok(catalog.ci.core_segments.includes(name))
  assert.equal(catalog.ci.core_shards.filter(shard => shard.split(',').includes(name)).length, 1)
  const scenario = createDesktopScenario({ uiTimeoutMs: 10000, modelResponseTimeoutMs: 30000 })
  assert.equal(typeof scenario.handleHttp, 'function')
  assert.equal(typeof scenario.verify, 'function')
})

test('image fixture identity is the original PNG byte hash', () => {
  assert.equal(IMAGE_BYTES.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(IMAGE_HASH, createHash('sha256').update(IMAGE_BYTES).digest('hex'))
})

test('recall fixture uses a complete independent role even when primary has no collaboration', () => {
  const template = {
    id: 'default',
    name: '',
    prompt: '',
    enabled: false,
    executionDeviceId: 'device',
    collaboration: {
      enabled: false,
      allProjects: true,
      projects: [],
      excludedProjects: [],
      tags: [],
    },
  }
  const settings = { primary: { enabled: true }, roles: [template] }
  const role = imageRecallRole(settings, 'image-reader')
  assert.equal(role.id, 'image-reader')
  assert.equal(role.executionDeviceId, 'device')
  assert.deepEqual(role.collaboration, template.collaboration)
  assert.equal(settings.roles[0].id, 'default')
})
