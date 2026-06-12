import { ArrowUp, Square } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ModelOptions, UnifiedModel } from '@/types/api'
import { AddContextMenu } from './AddContextMenu'
import { ModelSelector } from './ModelSelector'

interface ComposerToolbarProps {
  canSend: boolean
  disabled?: boolean
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  isModelSelectionReady: boolean
  onSelectModel: (model: UnifiedModel | null) => void
  onSelectModelOption: (optionId: string, value: string) => void
  onFileSelect: (files: File | File[]) => void
  isStreaming?: boolean
  onPause?: () => void
}

export function ComposerToolbar({
  canSend,
  disabled = false,
  models,
  selectedModel,
  selectedModelOptions,
  isModelSelectionReady,
  onSelectModel,
  onSelectModelOption,
  onFileSelect,
  isStreaming = false,
  onPause,
}: ComposerToolbarProps) {
  const { t } = useTranslation('common')

  return (
    <div className="mt-auto flex min-h-9 items-center justify-between gap-4">
      <div className="-ml-2 flex min-w-0 items-center gap-2">
        <AddContextMenu disabled={disabled} onFileSelect={onFileSelect} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isModelSelectionReady ? (
          <ModelSelector
            models={models}
            selectedModel={selectedModel}
            selectedModelOptions={selectedModelOptions}
            disabled={disabled}
            onSelectModel={onSelectModel}
            onSelectModelOption={onSelectModelOption}
          />
        ) : (
          <div
            className="h-11 w-32 shrink-0"
            data-testid="model-selector-loading"
          />
        )}
        {isStreaming ? (
          <button
            type="button"
            data-testid="pause-response-button"
            onClick={onPause}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1a1a1a] p-0 text-white hover:bg-[#333]"
            aria-label={t('workbench.pause_response', '暂停回复')}
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            data-testid="send-message-button"
            disabled={!canSend}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1a1a1a] p-0 text-white disabled:cursor-not-allowed disabled:bg-[#d9d9d9]"
            aria-label={t('workbench.send_message', '发送消息')}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
