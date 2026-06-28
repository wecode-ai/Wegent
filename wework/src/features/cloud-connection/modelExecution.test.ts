import { describe, expect, it } from 'vitest'
import type { UnifiedModel } from '@/types/api'
import {
  getModelExecutionOverride,
  resolveModelExecutionSelection,
  withModelExecutionOverride,
} from './modelExecution'

describe('modelExecution', () => {
  it('maps UI model names back to original execution names', () => {
    const uiModel = withModelExecutionOverride(
      {
        name: 'local:runtime:codex-gpt-5.5',
        type: 'runtime',
      } as UnifiedModel,
      {
        source: 'local',
        modelName: 'codex-gpt-5.5',
        modelType: 'runtime',
      }
    )

    expect(getModelExecutionOverride(uiModel)).toEqual({
      source: 'local',
      modelName: 'codex-gpt-5.5',
      modelType: 'runtime',
    })
    expect(resolveModelExecutionSelection(uiModel)).toEqual({
      modelName: 'codex-gpt-5.5',
      modelType: 'runtime',
    })
  })

  it('uses the model itself when no hybrid override is present', () => {
    expect(
      resolveModelExecutionSelection({
        name: 'claude-sonnet',
        type: 'public',
      } as UnifiedModel)
    ).toEqual({
      modelName: 'claude-sonnet',
      modelType: 'public',
    })
  })
})
