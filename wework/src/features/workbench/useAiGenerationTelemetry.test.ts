import { beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAiGenerationTelemetry } from './useAiGenerationTelemetry'
import type { RuntimeContextUsage, RuntimeTaskAddress, UnifiedModel } from '@/types/api'

const trackMock = vi.fn()

vi.mock('@/telemetry/client', () => ({
  track: (...args: unknown[]) => trackMock(...args),
}))

vi.stubGlobal('crypto', {
  randomUUID: () => 'gen-test-uuid',
})

const address: RuntimeTaskAddress = {
  deviceId: 'local-device',
  taskId: 'task-42',
}

function makeUsage(overrides?: Partial<RuntimeContextUsage['last']>): RuntimeContextUsage {
  return {
    total: {
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    last: {
      totalTokens: 1500,
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 500,
      reasoningOutputTokens: 0,
      ...overrides,
    },
    modelContextWindow: 128000,
  }
}

function makeModel(overrides?: Partial<UnifiedModel>): UnifiedModel {
  return {
    name: 'gpt-4o',
    type: 'public',
    displayName: 'GPT-4o',
    provider: 'openai',
    modelId: 'gpt-4o',
    ...overrides,
  } as UnifiedModel
}

describe('useAiGenerationTelemetry', () => {
  beforeEach(() => {
    trackMock.mockReset()
  })
  test('emits $ai_generation on settled with tokens, latency, model, provider, and cost', () => {
    const resolveModel = () => makeModel()
    const contextUsageByRuntimeTask = { 'local-device:task-42': makeUsage() }

    const { result } = renderHook(() =>
      useAiGenerationTelemetry({ resolveModel, contextUsageByRuntimeTask })
    )

    const beforeStart = Date.now()
    result.current.onAssistantStart(address)
    result.current.onAssistantSettled(address, 'success')
    const afterSettled = Date.now()

    expect(trackMock).toHaveBeenCalledWith(
      '$ai_generation',
      expect.objectContaining({
        $ai_generation_id: 'gen-test-uuid',
        $ai_parent_id: 'task-42',
        $ai_model: 'gpt-4o',
        $ai_provider: 'openai',
        $ai_input_tokens: 1000,
        $ai_output_tokens: 500,
        $ai_total_tokens: 1500,
        result: 'success',
      })
    )

    const call = trackMock.mock.calls.find(call => call[0] === '$ai_generation')
    expect(call?.[1].$ai_latency_ms).toBeGreaterThanOrEqual(0)
    expect(call?.[1].$ai_latency_ms).toBeLessThanOrEqual(afterSettled - beforeStart + 10)
    expect(call?.[1].$ai_cost).toBeGreaterThan(0)
  })

  test('emits result cancelled when settled with cancelled result', () => {
    const resolveModel = () => makeModel()
    const contextUsageByRuntimeTask = {}

    const { result } = renderHook(() =>
      useAiGenerationTelemetry({ resolveModel, contextUsageByRuntimeTask })
    )

    result.current.onAssistantStart(address)
    result.current.onAssistantSettled(address, 'cancelled')

    expect(trackMock).toHaveBeenCalledWith(
      '$ai_generation',
      expect.objectContaining({
        $ai_generation_id: 'gen-test-uuid',
        $ai_parent_id: 'task-42',
        $ai_model: 'gpt-4o',
        result: 'cancelled',
      })
    )
  })

  test('omits cost when model is unknown', () => {
    const resolveModel = () => makeModel({ name: 'unknown-model', modelId: 'unknown-model' })
    const contextUsageByRuntimeTask = { 'local-device:task-42': makeUsage() }

    const { result } = renderHook(() =>
      useAiGenerationTelemetry({ resolveModel, contextUsageByRuntimeTask })
    )

    result.current.onAssistantStart(address)
    result.current.onAssistantSettled(address, 'success')

    const call = trackMock.mock.calls.find(call => call[0] === '$ai_generation')
    expect(call?.[1]).not.toHaveProperty('$ai_cost')
  })

  test('does not emit when settled without a matching start', () => {
    const resolveModel = () => makeModel()
    const contextUsageByRuntimeTask = { 'local-device:task-42': makeUsage() }

    const { result } = renderHook(() =>
      useAiGenerationTelemetry({ resolveModel, contextUsageByRuntimeTask })
    )

    result.current.onAssistantSettled(address, 'success')

    expect(trackMock).not.toHaveBeenCalled()
  })
})
