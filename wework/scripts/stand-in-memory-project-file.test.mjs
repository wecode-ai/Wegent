import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-memory-project-file.scenario.mjs'

test('project delivery memory is independently runnable in the existing core CI shard', () => {
  const catalog = loadDesktopCheckpointCatalog()
  const name = 'stand-in-memory-project-file'
  assert.ok(catalog.DESKTOP_CHECKPOINTS.includes(name))
  assert.ok(catalog.SCENARIO_ONLY_CHECKPOINTS.has(name))
  assert.ok(catalog.ci.core_segments.includes(name))
  assert.equal(catalog.ci.core_shards.filter(shard => shard.split(',').includes(name)).length, 1)
  const scenario = createDesktopScenario({ uiTimeoutMs: 10000, modelResponseTimeoutMs: 30000 })
  assert.equal(typeof scenario.handleHttp, 'function')
  assert.equal(typeof scenario.verify, 'function')
})
