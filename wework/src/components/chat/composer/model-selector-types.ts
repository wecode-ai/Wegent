import type { ModelOptions, UnifiedModel } from '@/types/api'

export interface ModelSelectorProps {
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  nextTurn?: boolean
  disabled: boolean
  onSelectModel: (model: UnifiedModel | null) => void
  onSelectModelAndOptions?: (model: UnifiedModel, options: ModelOptions) => void
  onSelectModelOption: (optionId: string, value: string) => void
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  onOpenChange?: (open: boolean) => void
  openSignal?: number
  menuPlacement?: 'above' | 'below'
  buttonClassName?: string
  menuClassName?: string
  maxClosedWidth?: number
}
