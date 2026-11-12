import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTaskAddress, UnifiedModel } from '@/types/api'
import { runtimeTaskModelControlOverrides } from './runtimeTaskModelControls'
import type { RuntimeTaskModelSelectionControls } from './workbenchContextTypes'

const address: RuntimeTaskAddress = { deviceId: 'device-1', taskId: 'runtime-1' }
const taskModel: UnifiedModel = {
  name: 'task-model',
  displayName: 'Task model',
  type: 'public',
  provider: 'cloud',
}
const selection: RuntimeTaskModelSelectionControls = {
  selectionResolved: true,
  taskSelection: { modelName: 'task-model', modelType: 'public', options: { reasoning: 'high' } },
  selectedModel: taskModel,
  activeModel: taskModel,
  selectedModelOptions: { reasoning: 'high' },
}

function source() {
  return {
    resolveRuntimeTaskModelSelection: vi.fn(() => selection),
    setRuntimeTaskSelectedModel: vi.fn(),
    setRuntimeTaskSelectedModelAndOptions: vi.fn(),
    setRuntimeTaskSelectedModelOption: vi.fn(),
  }
}

describe('runtimeTaskModelControlOverrides', () => {
  it('binds selectors and getters to the addressed conversation', () => {
    const projectChat = source()
    const overrides = runtimeTaskModelControlOverrides(projectChat, address, selection)

    expect(overrides).toMatchObject({
      selectedModel: taskModel,
      activeModel: taskModel,
      selectedModelOptions: { reasoning: 'high' },
      isModelSelectionReady: true,
    })
    expect(overrides.getSelectedModel?.()).toBe(taskModel)
    expect(overrides.getSelectedModelOptions?.()).toEqual({ reasoning: 'high' })

    const nextModel = { ...taskModel, name: 'next-model' }
    overrides.setSelectedModel(nextModel)
    overrides.setSelectedModelAndOptions(nextModel, { reasoning: 'low' })
    overrides.setSelectedModelOption('reasoning', 'medium')

    expect(projectChat.setRuntimeTaskSelectedModel).toHaveBeenCalledWith(address, nextModel)
    expect(projectChat.setRuntimeTaskSelectedModelAndOptions).toHaveBeenCalledWith(
      address,
      nextModel,
      { reasoning: 'low' }
    )
    expect(projectChat.setRuntimeTaskSelectedModelOption).toHaveBeenCalledWith(
      address,
      'reasoning',
      'medium'
    )
  })

  it('keeps sending disabled while the conversation selection is unresolved', () => {
    const overrides = runtimeTaskModelControlOverrides(source(), address, {
      ...selection,
      selectionResolved: false,
      taskSelection: null,
      selectedModel: null,
      activeModel: null,
      selectedModelOptions: {},
    })

    expect(overrides.isModelSelectionReady).toBe(false)
    expect(overrides.selectedModel).toBeNull()
  })
})
