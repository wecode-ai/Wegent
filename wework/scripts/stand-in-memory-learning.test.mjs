import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-memory-learning.scenario.mjs'
import { assertMemoryReviewToolBoundary } from '../e2e/desktop/modules/stand-in-memory-consolidation.mjs'

test('memory review checks top-level and incremental tool definitions', () => {
  assertMemoryReviewToolBoundary({ tools: [{ name: 'mcp__wework_stand_in__next_memory_page' }] })
  for (const tool of [
    { name: 'exec_command' },
    { function: { name: 'apply_patch' } },
    { type: 'web_search' },
    { name: 'mcp__unrelated__read' },
  ]) {
    assert.throws(() => assertMemoryReviewToolBoundary({ tools: [tool] }))
    assert.throws(() =>
      assertMemoryReviewToolBoundary({
        input: [
          {
            type: 'additional_tools',
            tools: [{ type: 'namespace', name: 'functions', tools: [tool] }],
          },
        ],
      })
    )
  }
})

test('memory learning is independently selectable and assigned to the existing core CI lane', () => {
  const catalog = loadDesktopCheckpointCatalog()
  const name = 'stand-in-memory-learning'
  assert.ok(catalog.DESKTOP_CHECKPOINTS.includes(name))
  assert.ok(catalog.SCENARIO_ONLY_CHECKPOINTS.has(name))
  assert.ok(catalog.ci.core_segments.includes(name))
  assert.equal(catalog.ci.core_shards.filter(shard => shard.split(',').includes(name)).length, 1)
  assert.equal(
    catalog.CHECKPOINT_SCENARIO_MODULES[name],
    './scenarios/stand-in-memory-learning.scenario.mjs'
  )
  const scenario = createDesktopScenario({ uiTimeoutMs: 10000, modelResponseTimeoutMs: 30000 })
  assert.equal(typeof scenario.verify, 'function')
  assert.equal(typeof scenario.handleHttp, 'function')
})
