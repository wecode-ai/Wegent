import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from './checkpoint-catalog.mjs'

test('scheduler history regression is an independently runnable checkpoint in the existing CI shard', () => {
  const catalog = loadDesktopCheckpointCatalog()
  assert.equal(
    catalog.CHECKPOINT_SCENARIO_MODULES['coordination-history'],
    './scenarios/coordination-history.scenario.mjs'
  )
  assert.ok(catalog.SCENARIO_ONLY_CHECKPOINTS.has('coordination-history'))
  assert.ok(catalog.ci.core_shards[2].split(',').includes('coordination-history'))
})
