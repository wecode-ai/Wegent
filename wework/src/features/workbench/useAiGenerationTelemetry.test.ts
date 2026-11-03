import { resetRuntimeRunTraceIds, telemetryTraceId } from '@/telemetry/traceId'
import type { RuntimeContextUsage, RuntimeTaskAddress, UnifiedModel } from '@/types/api'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { resetGenerationOutcomesForTests } from './runtimeGenerationOutcome'
import { useAiGenerationTelemetry } from './useAiGenerationTelemetry'

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
})
