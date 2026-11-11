import type { ModelOptions, UnifiedModel } from '@/types/api'

export interface ConversationModelControls {
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  loading: boolean
  unavailable?: boolean
  unavailableReason?: 'conversation_runtime_unsupported'
  error?: string | null
  onModelSelectorOpenChange?(open: boolean): void
  setSelectedModel(model: UnifiedModel | null): void
  setSelectedModelAndOptions(model: UnifiedModel, options: ModelOptions): void
  setSelectedModelOption(optionId: string, value: string): void
}
