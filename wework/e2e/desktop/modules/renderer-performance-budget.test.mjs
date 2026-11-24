import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertRendererPerformanceBudget,
  RENDERER_PERFORMANCE_BUDGET,
} from './renderer-performance-budget.mjs'

test('every renderer budget is enforced independently at full precision', () => {
  assert.doesNotThrow(() => assertRendererPerformanceBudget(RENDERER_PERFORMANCE_BUDGET))
  const underBudget = Object.fromEntries(
    Object.keys(RENDERER_PERFORMANCE_BUDGET).map(name => [name, 0])
  )
  for (const [name, limit] of Object.entries(RENDERER_PERFORMANCE_BUDGET)) {
    assert.throws(
      () => assertRendererPerformanceBudget({ ...underBudget, [name]: limit + 0.01 }),
      new RegExp(name + ' .* exceeds ')
    )
  }
})

test('missing or invalid samples fail the checkpoint', () => {
  for (const clickToFrameMs of [undefined, NaN, Infinity, -1]) {
    assert.throws(
      () => assertRendererPerformanceBudget({ ...RENDERER_PERFORMANCE_BUDGET, clickToFrameMs }),
      /clickToFrameMs is missing or invalid/
    )
  }
})
