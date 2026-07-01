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
  modelSelectorOpenSignal?: number
  isModelSelectionReady: boolean
  onSelectModel: (model: UnifiedModel | null) => void
  onSelectModelOption: (optionId: string, value: string) => void
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
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
  modelSelectorOpenSignal,
  isModelSelectionReady,
  onSelectModel,
  onSelectModelOption,
  onBlockedModelSelect,
  onFileSelect,
  isStreaming = false,
  onPause,
}: ComposerToolbarProps) {
  const { t } = useTranslation('common')
  const collaborationMode = selectedModelOptions.collaborationMode ?? 'default'
  const planModeEnabled = collaborationMode === 'plan'

  return (
    <div className="mt-auto flex min-h-8 items-center justify-between gap-3 pt-1">
      <div className="flex min-w-0 items-center gap-2">
        <AddContextMenu disabled={disabled} onFileSelect={onFileSelect} />
        <button
          type="button"
          role="switch"
          aria-checked={planModeEnabled}
          data-testid="collaboration-mode-toggle"
          disabled={disabled}
          onClick={() =>
            onSelectModelOption('collaborationMode', planModeEnabled ? 'default' : 'plan')
          }
          className="flex h-8 shrink-0 items-center gap-2 rounded-full px-2 text-[13px] font-medium leading-[18px] text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('workbench.collaboration_mode', '运行模式')}
          title={t('workbench.collaboration_mode', '运行模式')}
        >
          <span
            className={[
              'relative h-4 w-7 rounded-full transition-colors',
              planModeEnabled ? 'bg-primary' : 'bg-border',
            ].join(' ')}
          >
            <span
              className={[
                'absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-background shadow-sm transition-transform',
                planModeEnabled ? 'translate-x-3' : 'translate-x-0',
              ].join(' ')}
            />
          </span>
          <span>{t('workbench.plan_mode', '计划模式')}</span>
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {isModelSelectionReady ? (
          <ModelSelector
            models={models}
            selectedModel={selectedModel}
            selectedModelOptions={selectedModelOptions}
            openSignal={modelSelectorOpenSignal}
            disabled={disabled}
            onSelectModel={onSelectModel}
            onSelectModelOption={onSelectModelOption}
            onBlockedModelSelect={onBlockedModelSelect}
            buttonClassName="opacity-90 hover:opacity-100"
          />
        ) : (
          <div className="h-11 w-32 shrink-0" data-testid="model-selector-loading" />
        )}
        {isStreaming ? (
          <button
            type="button"
            data-testid="pause-response-button"
            onClick={onPause}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1f1f1f] p-0 text-white hover:bg-[#333]"
            aria-label={t('workbench.pause_response', '暂停回复')}
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            data-testid="send-message-button"
            disabled={!canSend}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1f1f1f] p-0 text-white disabled:cursor-not-allowed disabled:bg-text-muted/45 disabled:text-background"
            aria-label={t('workbench.send_message', '发送消息')}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
