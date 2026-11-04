// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { runtimeContextUsageMetrics } from './runtime-context-usage'

describe('runtimeContextUsageMetrics', () => {
  test('falls back to cumulative usage when latest usage is unavailable', () => {
    expect(
      runtimeContextUsageMetrics({
        total: {
          totalTokens: 15_000,
          inputTokens: 12_000,
          cachedInputTokens: 2_000,
          outputTokens: 3_000,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: Number.NaN,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 258_400,
      })
    )?.toMatchObject({
      usedTokens: 15_000,
      usedPercent: 6,
    })
  })
})
