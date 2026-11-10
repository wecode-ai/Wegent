import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelOptions, ModelSelectionConfig, UnifiedModel } from '@/types/api'
import { runtimeTaskBindingAddress } from '@/features/todo/runtimeTaskBindingAddress'
import { useRuntimeTaskModelSelection } from './useRuntimeTaskModelSelection'
import { requiresNewSessionForModelSwitch } from './modelSwitch'
import { getRuntimeTaskChatScopeKey } from './workbenchProviderHelpers'

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
  const official: UnifiedModel = {
    name: 'gpt-6.1-sol',
    type: 'runtime',
    provider: 'local',
    config: { weworkModelKind: 'codex-official' },
  }
  it.each<{ modelName: string; options: ModelOptions; target: UnifiedModel }>([
    {
      modelName: 'local-model:desktop-e2e-responses',
      options: { runnerModelProvider: 'local-desktop-e2e-responses' },
      target: official,
    },
    {
      modelName: 'deepseek-custom-provider',
      options: { codexProviderId: 'custom-provider', codexProviderType: 'provider' },
      target: official,
    },
    {
      modelName: 'gpt-6.1-sol',
      options: { codexProviderId: 'openai', codexProviderType: 'official' },
      target: { name: 'deepseek', type: 'public', provider: 'cloud' },
    },
  ])(
    'retains the persisted provider without a live catalog: $modelName',
    ({ modelName, options, target }) => {
      const source = runtimeTaskBindingAddress({
        device_id: 'local-device',
        task_id: 'stand-in-chat-7-primary',
        modelSelection: {
          modelName,
          modelType: 'runtime',
          options,
        },
      })
      const { result } = renderHook(() =>
        useRuntimeTaskModelSelection({
          userId: 7,
          resolveTask: () => null,
          modelStore: modelStore([]),
        })
      )
      const restored = result.current.resolveRuntimeTaskModelSelection(source)
      expect(requiresNewSessionForModelSwitch(restored.activeModel, target)).toBe(true)
      expect(restored.selectedModelOptions).toEqual(options)
    }
  )

  it('does not infer an official provider from a model name alone', () => {
    const source = runtimeTaskBindingAddress({
      device_id: 'local-device',
      task_id: 'stand-in-chat-7-primary',
      modelSelection: { modelName: 'gpt-custom', modelType: 'runtime', options: {} },
    })
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({
        userId: 7,
        resolveTask: () => null,
        modelStore: modelStore([]),
      })
    )
    expect(
      result.current.resolveRuntimeTaskModelSelection(source).activeModel?.config
    ).toBeUndefined()
  })

  it('uses the persisted model before the remote task list and model catalog are available', () => {
    const store = modelStore([])
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({ userId: 7, resolveTask: () => null, modelStore: store })
    )

    expect(result.current.resolveRuntimeTaskModelSelection(address)).toMatchObject({
      taskSelection: selection,
      activeModelSelection: selection,
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
      useRuntimeTaskModelSelection({ userId: 7, resolveTask: () => null, modelStore: store })
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

  it('keeps the accepted switch session before the task list refreshes', () => {
    const target: UnifiedModel = {
      name: 'gpt-6.1-sol',
      type: 'runtime',
      provider: 'local',
      config: { weworkModelKind: 'codex-official' },
    }
    const targetSelection: ModelSelectionConfig = {
      modelName: 'gpt-6.1-sol',
      modelType: 'runtime',
      options: { collaborationMode: 'default', reasoning: 'high' },
    }
    const store = modelStore([target])
    const scopeKey = `user:7:${getRuntimeTaskChatScopeKey(address)}`
    store.selectedModelByScope[scopeKey] = target
    const resolvedTask = {
      taskId: address.taskId,
      workspacePath: '/tmp/workspace',
      title: 'Stand-in',
      runtime: 'codex',
      modelSelection: selection,
    }
    const { result, rerender } = renderHook(() =>
      useRuntimeTaskModelSelection({
        userId: 7,
        resolveTask: () => resolvedTask,
        modelStore: store,
      })
    )

    expect(
      requiresNewSessionForModelSwitch(
        result.current.resolveRuntimeTaskModelSelection(address).activeModel,
        target
      )
    ).toBe(true)

    act(() =>
      result.current.confirmRuntimeTaskActiveModel(address, target, {
        modelId: targetSelection.modelName,
        modelType: targetSelection.modelType,
        modelOptions: targetSelection.options,
      })
    )
    rerender()

    const afterSwitch = result.current.resolveRuntimeTaskModelSelection(address)
    expect(afterSwitch.activeModel).toEqual(target)
    expect(afterSwitch.activeModelSelection).toEqual(targetSelection)
    expect(requiresNewSessionForModelSwitch(afterSwitch.activeModel, target)).toBe(false)

    resolvedTask.modelSelection = targetSelection
    rerender()

    expect(result.current.resolveRuntimeTaskModelSelection(address).activeModelSelection).toEqual(
      targetSelection
    )

    const nextModel: UnifiedModel = { name: 'deepseek', type: 'public', provider: 'cloud' }
    store.selectedModelByScope[scopeKey] = nextModel
    rerender()

    const afterNextSelection = result.current.resolveRuntimeTaskModelSelection(address)
    expect(afterNextSelection.selectedModel).toEqual(nextModel)
    expect(requiresNewSessionForModelSwitch(afterNextSelection.activeModel, nextModel)).toBe(true)
  })
})
