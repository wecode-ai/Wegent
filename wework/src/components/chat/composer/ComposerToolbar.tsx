import { ArrowUp, Mic } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ModelOptions, UnifiedModel } from '@/types/api'
import { AddContextMenu } from './AddContextMenu'
import { ModelSelector } from './ModelSelector'

interface ComposerToolbarProps {
  canSend: boolean
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  isModelSelectionReady: boolean
  onSelectModel: (model: UnifiedModel | null) => void
  onSelectModelOption: (optionId: string, value: string) => void
  onFileSelect: (files: File | File[]) => void
}

export function ComposerToolbar({
  canSend,
  models,
  selectedModel,
  selectedModelOptions,
  isModelSelectionReady,
  onSelectModel,
  onSelectModelOption,
  onFileSelect,
}: ComposerToolbarProps) {
  const { t } = useTranslation('common')

  return (
    <div className="mt-auto flex min-h-9 items-center justify-between gap-4">
      <div className="-ml-2 flex min-w-0 items-center gap-2">
        <AddContextMenu disabled={false} onFileSelect={onFileSelect} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isModelSelectionReady ? (
          <ModelSelector
            models={models}
            selectedModel={selectedModel}
            selectedModelOptions={selectedModelOptions}
            disabled={false}
            onSelectModel={onSelectModel}
            onSelectModelOption={onSelectModelOption}
          />
        ) : (
          <div
            className="h-11 w-32 shrink-0"
            data-testid="model-selector-loading"
          />
        )}
        <button
          type="button"
          data-testid="voice-input-button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full p-0 text-text-secondary hover:bg-muted"
          aria-label={t('workbench.voice_input', '语音输入')}
        >
          <Mic className="h-4 w-4" />
        </button>
        <button
          type="submit"
          data-testid="send-message-button"
          disabled={!canSend}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1a1a1a] p-0 text-white disabled:cursor-not-allowed disabled:bg-[#d9d9d9]"
          aria-label={t('workbench.send_message', '发送消息')}
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
