import type { ProjectChatControls } from '@/components/chat/ChatInput'
import type { ModelOptions, RuntimeTaskAddress, UnifiedModel } from '@/types/api'
import type { RuntimeTaskModelSelectionControls } from './workbenchContextTypes'

interface RuntimeTaskModelControlSource {
  resolveRuntimeTaskModelSelection: (
    address: RuntimeTaskAddress
  ) => RuntimeTaskModelSelectionControls
  setRuntimeTaskSelectedModel: (address: RuntimeTaskAddress, model: UnifiedModel | null) => void
  setRuntimeTaskSelectedModelAndOptions: (
    address: RuntimeTaskAddress,
    model: UnifiedModel,
    options: ModelOptions
  ) => void
  setRuntimeTaskSelectedModelOption: (
    address: RuntimeTaskAddress,
    optionId: string,
    value: string
  ) => void
}

export type RuntimeTaskModelControlOverrides = Pick<
  ProjectChatControls,
  | 'activeModel'
  | 'selectedModel'
  | 'selectedModelOptions'
  | 'supportsModelProviderSwitch'
  | 'isModelSelectionReady'
  | 'setSelectedModel'
  | 'setSelectedModelAndOptions'
  | 'setSelectedModelOption'
  | 'getSelectedModel'
  | 'getSelectedModelOptions'
>

/**
 * Bind a conversation surface's model controls to the address it renders.
 *
 * Split panes share one workbench provider. Reading the provider's active
 * scope would make an inactive pane show, and send with, another
 * conversation's model.
 */
export function runtimeTaskModelControlOverrides(
  source: RuntimeTaskModelControlSource,
  address: RuntimeTaskAddress,
  selection: RuntimeTaskModelSelectionControls
): RuntimeTaskModelControlOverrides {
  return {
    activeModel: selection.activeModel,
    selectedModel: selection.selectedModel,
    selectedModelOptions: selection.selectedModelOptions,
    supportsModelProviderSwitch: selection.supportsModelProviderSwitch,
    isModelSelectionReady: selection.selectionResolved,
    setSelectedModel: model => source.setRuntimeTaskSelectedModel(address, model),
    setSelectedModelAndOptions: (model, options) =>
      source.setRuntimeTaskSelectedModelAndOptions(address, model, options),
    setSelectedModelOption: (optionId, value) =>
      source.setRuntimeTaskSelectedModelOption(address, optionId, value),
    getSelectedModel: () => source.resolveRuntimeTaskModelSelection(address).selectedModel,
    getSelectedModelOptions: () =>
      source.resolveRuntimeTaskModelSelection(address).selectedModelOptions,
  }
}
