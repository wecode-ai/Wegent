import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelSelectionConfig, RuntimeTaskSummary, UnifiedModel } from '@/types/api'
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
  it('reads provider switch capability from the owning runtime task without inheriting another task', () => {
    const task = {
      modelSelection: selection,
      runtimeHandle: { modelProviderRouting: 'thread' },
    } as RuntimeTaskSummary
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({
        userId: 7,
        resolveTask: current => (current.taskId === address.taskId ? task : null),
        modelStore: modelStore([]),
      })
    )
    expect(
      result.current.resolveRuntimeTaskModelSelection(address).supportsModelProviderSwitch
    ).toBe(true)
    expect(
      result.current.resolveRuntimeTaskModelSelection({ ...address, taskId: 'legacy' })
        .supportsModelProviderSwitch
    ).toBeUndefined()
  })

  it('uses the persisted model before the remote task list and model catalog are available', () => {
    const store = modelStore([])
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({ userId: 7, resolveTask: () => null, modelStore: store })
    )

    expect(result.current.resolveRuntimeTaskModelSelection(address)).toMatchObject({
      selectionResolved: true,
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

  it('reports an unresolved conversation instead of inventing a model', () => {
    const store = modelStore([])
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({ userId: 7, resolveTask: () => null, modelStore: store })
    )

    expect(
      result.current.resolveRuntimeTaskModelSelection({
        deviceId: 'remote-device',
        taskId: 'runtime-1',
      })
    ).toMatchObject({
      selectionResolved: false,
      taskSelection: null,
      selectedModel: null,
      selectedModelOptions: {},
    })
  })

  it('treats a model chosen in the pane as resolved before the task summary arrives', () => {
    const store = modelStore([])
    store.selectedModelByScope = {
      'user:7:runtime:remote-device:runtime-3': {
        name: 'picked-model',
        type: 'runtime',
        provider: 'local',
      },
    }
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({ userId: 7, resolveTask: () => null, modelStore: store })
    )

    expect(
      result.current.resolveRuntimeTaskModelSelection({
        deviceId: 'remote-device',
        taskId: 'runtime-3',
      })
    ).toMatchObject({
      selectionResolved: true,
      selectedModel: { name: 'picked-model' },
    })
  })

  it('treats a loaded task without a Wework model as resolved to the native default', () => {
    const store = modelStore([])
    const unresolvedAddress = { deviceId: 'remote-device', taskId: 'runtime-2' }
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({
        userId: 7,
        resolveTask: target =>
          target.taskId === unresolvedAddress.taskId
            ? {
                taskId: target.taskId,
                workspacePath: '/workspace',
                title: 'Legacy task',
                runtime: 'codex',
                running: false,
              }
            : null,
        modelStore: store,
      })
    )

    expect(result.current.resolveRuntimeTaskModelSelection(unresolvedAddress)).toMatchObject({
      selectionResolved: true,
      taskSelection: null,
      selectedModel: null,
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
})
