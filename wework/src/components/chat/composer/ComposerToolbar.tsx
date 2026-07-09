import { ArrowUp, Square } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ModelOptions, RuntimeContextUsage, UnifiedModel } from '@/types/api'
import { AddContextMenu } from './AddContextMenu'
import { ComposerModePill, GoalDraftPill } from './GoalDraftPill'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import { ModelSelector } from './ModelSelector'

interface ComposerToolbarProps {
  canSend: boolean
  disabled?: boolean
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  modelSelectorOpenSignal?: number
  isModelSelectionReady: boolean
  contextUsage?: RuntimeContextUsage
  onSelectModel: (model: UnifiedModel | null) => void
  onSelectModelOption: (optionId: string, value: string) => void
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  onFileSelect: (files: File | File[]) => void
  planModeActive?: boolean
  onSetPlanMode?: () => void
  onClearPlanMode?: () => void
  onSetGoal?: () => void
  onCompactContext?: () => void
  goalDraftActive?: boolean
  onCancelGoalDraft?: () => void
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
  contextUsage,
  onSelectModel,
  onSelectModelOption,
  onBlockedModelSelect,
  onFileSelect,
  planModeActive = false,
  onSetPlanMode,
  onClearPlanMode,
  onSetGoal,
  onCompactContext,
  goalDraftActive = false,
  onCancelGoalDraft,
  isStreaming = false,
  onPause,
}: ComposerToolbarProps) {
  const { t } = useTranslation('common')

  return (
    <div className="mt-auto flex min-h-8 items-center justify-between gap-3 pt-1">
      <div className="flex min-w-0 items-center gap-2">
        <AddContextMenu
          disabled={disabled}
          onFileSelect={onFileSelect}
          onSetPlanMode={planModeActive ? undefined : onSetPlanMode}
          onSetGoal={onSetGoal}
        />
        {goalDraftActive ? (
          <GoalDraftPill onCancel={onCancelGoalDraft} />
        ) : planModeActive ? (
          <ComposerModePill
            label={t('workbench.plan_mode', '计划模式')}
            testId="plan-mode-pill"
            cancelTestId="cancel-plan-mode-button"
            cancelLabel={t('workbench.disable_plan_mode', '关闭计划模式')}
            disabled={disabled}
            onCancel={onClearPlanMode}
            title={t('workbench.collaboration_mode', '运行模式')}
          />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <ContextUsageIndicator
          usage={contextUsage}
          disabled={disabled}
          onCompactContext={onCompactContext}
        />
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
