import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelSelectionConfig, UnifiedModel } from '@/types/api'
import { runtimeTaskBindingAddress } from '@/features/todo/runtimeTaskBindingAddress'
import { useRuntimeTaskModelSelection } from './useRuntimeTaskModelSelection'

const selection: ModelSelectionConfig = {
  modelName: 'deepseek-v4-pro-responses(公网)',
  modelType: 'public',
  options: {
    weworkCloudModelNamespace: 'default',
    weworkCloudModelResourceUserId: '0',
    weworkCloudModelCodexCatalogModelId: 'wework-deepseek-v4-pro',
  },
}
const address = runtimeTaskBindingAddress({
  device_id: 'remote-device',
  task_id: 'codex-queue-85',
  modelSelection: selection,
})

function modelStore(models: UnifiedModel[]) {
  return {
    models,
    selectedModelByScope: {},
    selectedModelOptionsByScope: {},
    hasSelectionForScope: vi.fn().mockReturnValue(false),
    setSelectionForScope: vi.fn(),
    setSelectedModelForScope: vi.fn(),
    setSelectedModelAndOptionsForScope: vi.fn(),
    setSelectedModelOptionForScope: vi.fn(),
  }
}

describe('bound remote task model selection', () => {
  it('uses the persisted model before the remote task list and model catalog are available', () => {
    const store = modelStore([])
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({ userId: 7, runtimeWork: null, modelStore: store })
    )

    expect(result.current.resolveRuntimeTaskModelSelection(address)).toMatchObject({
      taskSelection: selection,
      selectedModelOptions: selection.options,
      activeModel: {
        name: selection.modelName,
        type: 'public',
        namespace: 'default',
        resourceUserId: 0,
      },
      selectedModel: { name: selection.modelName, type: 'public' },
    })
  })

  it('does not substitute another catalog model and retains the task model when editing an option', () => {
    const store = modelStore([
      { name: 'gpt-6-astra', displayName: 'GPT-6 Astra', type: 'runtime', provider: 'local' },
    ])
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({ userId: 7, runtimeWork: null, modelStore: store })
    )

    result.current.setRuntimeTaskSelectedModelOption(address, 'reasoning', 'high')

    expect(store.setSelectionForScope).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ name: selection.modelName, type: 'public' }),
      selection.options,
      selection
    )
    expect(store.setSelectedModelOptionForScope).toHaveBeenCalledWith(
      expect.any(String),
      'reasoning',
      'high'
    )
  })
})
