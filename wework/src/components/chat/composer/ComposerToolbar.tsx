import {
  ArrowUp,
  ChevronDown,
  ClipboardList,
  Clock3,
  Cloud,
  CornerDownRight,
  Laptop,
  Zap,
} from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { ActionMenu } from '@/components/common/ActionMenu'
import type { ComposerSubmitOptions } from './ComposerTextarea'
import { useTranslation } from '@/hooks/useTranslation'
import type { ModelOptions, RuntimeContextUsage, UnifiedModel } from '@/types/api'
import { AddContextMenu } from './AddContextMenu'
import { ComposerModePill, GoalDraftPill } from './GoalDraftPill'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import { ModelSelector } from './ModelSelector'
import { QuickPhraseMenu } from './QuickPhraseMenu'
import type { QuickPhrase } from '@/tauri/appPreferences'

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
  onSelectModelAndOptions?: (model: UnifiedModel, options: ModelOptions) => void
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
  onQuickPhraseSelect: (phrase: QuickPhrase) => void
  onSubmit: (options?: ComposerSubmitOptions) => void
  executionDevice?: {
    kind: 'cloud' | 'local'
    label: string
    selectable: boolean
    onSelect?: () => void
  }
}

const COMPACT_TOOLBAR_WIDTH = 475
const NARROW_MODEL_SELECTOR_MAX_WIDTH = 160

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
  onSelectModelAndOptions,
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
  onQuickPhraseSelect,
  onSubmit,
  executionDevice,
}: ComposerToolbarProps) {
  const { t } = useTranslation('common')
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar || typeof ResizeObserver === 'undefined') return
    const updateCompact = (width: number) => setCompact(width < COMPACT_TOOLBAR_WIDTH)
    updateCompact(toolbar.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) updateCompact(entry.contentRect.width)
    })
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={toolbarRef}
      data-testid="composer-toolbar"
      data-compact={compact ? 'true' : 'false'}
      className="mt-auto flex min-h-8 min-w-0 items-center justify-between gap-2 pt-1"
    >
      <div className="flex min-w-0 items-center gap-2">
        <AddContextMenu
          disabled={disabled}
          onFileSelect={onFileSelect}
          onSetPlanMode={planModeActive ? undefined : onSetPlanMode}
          onSetGoal={onSetGoal}
        />
        <QuickPhraseMenu disabled={disabled} iconOnly={compact} onSelect={onQuickPhraseSelect} />
        {goalDraftActive ? (
          <GoalDraftPill onCancel={onCancelGoalDraft} />
        ) : planModeActive ? (
          <ComposerModePill
            label={t('workbench.plan_mode', '计划模式')}
            icon={ClipboardList}
            testId="plan-mode-pill"
            cancelTestId="cancel-plan-mode-button"
            cancelLabel={t('workbench.disable_plan_mode', '关闭计划模式')}
            disabled={disabled}
            onCancel={onClearPlanMode}
            title={t('workbench.collaboration_mode', '运行模式')}
          />
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        {executionDevice && (
          <button
            type="button"
            data-testid="composer-execution-device-button"
            onClick={executionDevice.onSelect}
            aria-disabled={!executionDevice.selectable}
            title={executionDevice.label}
            aria-label={executionDevice.label}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-muted hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-disabled:hover:text-text-muted"
          >
            {executionDevice.kind === 'cloud' ? (
              <Cloud className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Laptop className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        )}
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
            onSelectModelAndOptions={onSelectModelAndOptions}
            onSelectModelOption={onSelectModelOption}
            onBlockedModelSelect={onBlockedModelSelect}
            buttonClassName="opacity-90 hover:opacity-100"
            maxClosedWidth={compact ? NARROW_MODEL_SELECTOR_MAX_WIDTH : undefined}
          />
        ) : (
          <div className="h-11 w-32 shrink-0" data-testid="model-selector-loading" />
        )}
        {isStreaming && !canSend ? (
          <button
            type="button"
            data-testid="pause-response-button"
            onClick={onPause}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1f1f1f] p-0 text-white hover:bg-[#333]"
            aria-label={t('workbench.pause_response', '暂停回复')}
          >
            <span className="h-3.5 w-3.5 rounded-sm bg-current" aria-hidden="true" />
          </button>
        ) : isStreaming && canSend ? (
          <div className="flex items-center rounded-full bg-[#1f1f1f] text-white">
            <button
              type="submit"
              data-testid="send-message-button"
              className="flex h-8 w-8 items-center justify-center rounded-l-full hover:bg-[#333]"
              aria-label={t('workbench.send_after_turn', '当前回复结束后发送')}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
            <ActionMenu
              ariaLabel={t('workbench.choose_send_mode', '选择发送方式')}
              testId="send-mode-menu-button"
              icon={ChevronDown}
              triggerClassName="flex h-8 w-7 items-center justify-center rounded-r-full border-l border-white/20 hover:bg-[#333]"
              items={[
                {
                  label: t('workbench.send_after_turn', '当前回复结束后发送'),
                  icon: Clock3,
                  testId: 'send-after-turn-option',
                  onSelect: () => onSubmit(),
                },
                {
                  label: t('workbench.guide_current_turn', '引导当前回复'),
                  icon: CornerDownRight,
                  testId: 'guide-current-turn-option',
                  onSelect: () => onSubmit({ guideWhenBusy: true }),
                },
                {
                  label: t('workbench.interrupt_and_send', '打断并立即发送'),
                  icon: Zap,
                  testId: 'interrupt-and-send-option',
                  onSelect: () => onSubmit({ interruptWhenBusy: true }),
                },
              ]}
            />
          </div>
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
