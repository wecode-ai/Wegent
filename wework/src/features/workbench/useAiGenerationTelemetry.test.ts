import { beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAiGenerationTelemetry } from './useAiGenerationTelemetry'
import { resetRuntimeRunTraceIds, telemetryTraceId } from '@/telemetry/traceId'
import { peekGenerationOutcome, resetGenerationOutcomesForTests } from './runtimeGenerationOutcome'
import type { RuntimeContextUsage, RuntimeTaskAddress, UnifiedModel } from '@/types/api'

const trackMock = vi.fn()

vi.mock('@/telemetry/client', () => ({
  track: (...args: unknown[]) => trackMock(...args),
}))

vi.stubGlobal('crypto', {
  randomUUID: () => 'gen-test-uuid',
})

const RUN_TRACE_ID = telemetryTraceId('gen-test-uuid')

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

const knownModelIds = new Set(['gpt-4o'])

describe('useAiGenerationTelemetry', () => {
  beforeEach(() => {
    trackMock.mockReset()
    resetRuntimeRunTraceIds()
    resetGenerationOutcomesForTests()
  })
  test('emits $ai_generation on settled with tokens, latency, model, and provider', () => {
    const resolveModel = () => makeModel()
    const contextUsageByRuntimeTask = { 'local-device:task-42': makeUsage() }

    const { result } = renderHook(() =>
      useAiGenerationTelemetry({ resolveModel, contextUsageByRuntimeTask, knownModelIds })
    )

    const beforeStart = Date.now()
    result.current.onAssistantStart(address, 'subtask-1')
    result.current.onAssistantSettled(address, 'subtask-1', 'success')
    const afterSettled = Date.now()

    expect(trackMock).toHaveBeenCalledWith(
      '$ai_generation',
      expect.objectContaining({
        $ai_generation_id: 'gen-test-uuid',
        $ai_trace_id: RUN_TRACE_ID,
        $ai_parent_id: RUN_TRACE_ID,
        $ai_model: 'gpt-4o',
        $ai_provider: 'openai',
        $ai_input_tokens: 1000,
        $ai_output_tokens: 500,
        $ai_total_tokens: 1500,
        result: 'success',
      })
    )

    const call = trackMock.mock.calls.find(call => call[0] === '$ai_generation')
    expect(call?.[1].$ai_latency).toBeGreaterThanOrEqual(0)
    expect(call?.[1].$ai_latency).toBeLessThanOrEqual((afterSettled - beforeStart + 10) / 1000)
    expect(call?.[1]).not.toHaveProperty('$ai_cost')
  })

  test('uses the context usage passed at settle over the conversation snapshot', () => {
    const resolveModel = () => makeModel()
    // The conversation snapshot has no usage for this task, so only the usage
    // carried by the settled event should populate token counts.
    const contextUsageByRuntimeTask = {}

    const { result } = renderHook(() =>
      useAiGenerationTelemetry({ resolveModel, contextUsageByRuntimeTask, knownModelIds })
    )

    result.current.onAssistantStart(address, 'subtask-1')
    result.current.onAssistantSettled(address, 'subtask-1', 'success', makeUsage())

    const call = trackMock.mock.calls.find(call => call[0] === '$ai_generation')
    expect(call?.[1]).toEqual(
      expect.objectContaining({
        $ai_input_tokens: 1000,
        $ai_output_tokens: 500,
        $ai_total_tokens: 1500,
      })
    )
  })

  test('emits result cancelled when settled with cancelled result', () => {
    const resolveModel = () => makeModel()
    const contextUsageByRuntimeTask = {}

    const { result } = renderHook(() =>
      useAiGenerationTelemetry({ resolveModel, contextUsageByRuntimeTask, knownModelIds })
    )

    result.current.onAssistantStart(address, 'subtask-1')
    result.current.onAssistantSettled(address, 'subtask-1', 'cancelled')

    expect(trackMock).toHaveBeenCalledWith(
      '$ai_generation',
      expect.objectContaining({
        $ai_generation_id: 'gen-test-uuid',
        $ai_trace_id: RUN_TRACE_ID,
        $ai_parent_id: RUN_TRACE_ID,
        $ai_model: 'gpt-4o',
        result: 'cancelled',
      })
    )
  })

  test('collapses unrecognized model ids to other', () => {
    const resolveModel = () => makeModel({ name: 'unknown-model', modelId: 'unknown-model' })
    const contextUsageByRuntimeTask = { 'local-device:task-42': makeUsage() }

    const { result } = renderHook(() =>
      useAiGenerationTelemetry({ resolveModel, contextUsageByRuntimeTask, knownModelIds })
    )

    result.current.onAssistantStart(address, 'subtask-1')
    result.current.onAssistantSettled(address, 'subtask-1', 'success')

    expect(trackMock).toHaveBeenCalledWith(
      '$ai_generation',
      expect.objectContaining({
        $ai_model: 'other',
        $ai_provider: 'openai',
      })
    )
    const call = trackMock.mock.calls.find(call => call[0] === '$ai_generation')
    expect(call?.[1]).not.toHaveProperty('$ai_cost')
  })

  test('tracks concurrent subtasks independently', () => {
    const resolveModel = () => makeModel()
    const contextUsageByRuntimeTask = { 'local-device:task-42': makeUsage() }

    const { result } = renderHook(() =>
      useAiGenerationTelemetry({ resolveModel, contextUsageByRuntimeTask, knownModelIds })
    )

    result.current.onAssistantStart(address, 'subtask-a')
    result.current.onAssistantStart(address, 'subtask-b')
    result.current.onAssistantSettled(address, 'subtask-a', 'success')
    result.current.onAssistantSettled(address, 'subtask-b', 'success')

    expect(trackMock.mock.calls.filter(call => call[0] === '$ai_generation')).toHaveLength(2)
  })

  test('does not emit when settled without a matching start', () => {
    const resolveModel = () => makeModel()
    const contextUsageByRuntimeTask = { 'local-device:task-42': makeUsage() }

    const { result } = renderHook(() =>
      useAiGenerationTelemetry({ resolveModel, contextUsageByRuntimeTask, knownModelIds })
    )

    result.current.onAssistantSettled(address, 'subtask-1', 'success')

    expect(trackMock).not.toHaveBeenCalled()
  })

  test('records the settled result so run-level events can reflect it', () => {
    const resolveModel = () => makeModel()
    const contextUsageByRuntimeTask = { 'local-device:task-42': makeUsage() }

    const { result } = renderHook(() =>
      useAiGenerationTelemetry({ resolveModel, contextUsageByRuntimeTask, knownModelIds })
    )

    result.current.onAssistantStart(address, 'subtask-1')
    result.current.onAssistantSettled(address, 'subtask-1', 'failure')

    expect(peekGenerationOutcome(address)).toBe('failure')
  })

  test('does not record an outcome when settled without a matching start', () => {
    const resolveModel = () => makeModel()
    const contextUsageByRuntimeTask = { 'local-device:task-42': makeUsage() }

    const { result } = renderHook(() =>
      useAiGenerationTelemetry({ resolveModel, contextUsageByRuntimeTask, knownModelIds })
    )

    result.current.onAssistantSettled(address, 'subtask-1', 'failure')

    expect(peekGenerationOutcome(address)).toBeNull()
  })
})
