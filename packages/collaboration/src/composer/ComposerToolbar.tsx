import { ArrowUp, ChevronDown, ClipboardList, Clock3, CornerDownRight, Zap } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ActionMenu } from '../controls/ActionMenu'
import type { ComposerSubmitOptions } from './composerInputTypes'
import type { ComposerFollowUpBehavior } from './composerInputTypes'
import type { CollaborationTranslate } from '../i18n'
import { Tooltip } from '../issue-detail/Tooltip'
import type { ModelOptions, UnifiedModel } from '@wegent/chat-core/models'

import { AddContextMenu } from './AddContextMenu'
import { ComposerModePill, GoalDraftPill } from './GoalDraftPill'

import type { ModelSelectorCloseReason } from '../controls/model-selector-types'

import { PermissionModeSelector } from '../controls/PermissionModeSelector'
import {
  RUNTIME_PERMISSION_MODE_OPTION,
  runtimePermissionMode,
} from '@wegent/chat-core/runtime-permission'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export interface ComposerToolbarProps {
  translate: CollaborationTranslate
  renderFeatureMenus?: (compact: boolean) => ReactNode
  contextUsageIndicator?: ReactNode
  workspaceMenu?: ReactNode
  renderModelSelector: (
    props: import('../controls/model-selector-types').ModelSelectorProps
  ) => ReactNode
  className?: string
  canSend: boolean
  disabled?: boolean
  showExecutionTools?: boolean
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  activeModel?: UnifiedModel | null
  selectedModelOptions: ModelOptions
  modelSelectorOpenSignal?: number
  onModelSelectorOpenChange?: (open: boolean, closeReason?: ModelSelectorCloseReason) => void
  isModelSelectionReady: boolean
  onSelectModel: (model: UnifiedModel | null) => boolean | void
  onSelectModelAndOptions?: (model: UnifiedModel, options: ModelOptions) => void
  onSelectModelOption: (optionId: string, value: string) => void
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  modelSelectorOverride?: ReactNode
  onFileSelect: (files: File | File[]) => void
  planModeActive?: boolean
  onSetPlanMode?: () => void
  onClearPlanMode?: () => void
  onSetGoal?: () => void
  onConfigureSupervisor?: () => void
  supervisorEnabled?: boolean
  supervisorPending?: boolean
  onCompactContext?: () => void
  goalDraftActive?: boolean
  onCancelGoalDraft?: () => void
  isStreaming?: boolean
  onPause?: () => void
  onSubmit: (options?: ComposerSubmitOptions) => void
  sendButtonTestId?: string
  sendButtonLabel?: string
  leadingContext?: ReactNode
  sendKey?: 'enter' | 'cmd_enter'
  followUpBehavior?: ComposerFollowUpBehavior
}

const COMPACT_TOOLBAR_WIDTH = 475
const NARROW_MODEL_SELECTOR_MAX_WIDTH = 160

export function ComposerToolbar({
  translate: t,
  renderFeatureMenus,
  contextUsageIndicator,
  workspaceMenu,
  renderModelSelector,
  className,
  canSend,
  disabled = false,
  showExecutionTools = true,
  models,
  selectedModel,
  activeModel,
  selectedModelOptions,
  modelSelectorOpenSignal,
  onModelSelectorOpenChange,
  isModelSelectionReady,
  onSelectModel,
  onSelectModelAndOptions,
  onSelectModelOption,
  onBlockedModelSelect,
  modelSelectorOverride,
  onFileSelect,
  planModeActive = false,
  onSetPlanMode,
  onClearPlanMode,
  onSetGoal,
  onConfigureSupervisor,
  supervisorEnabled = false,
  supervisorPending = false,
  goalDraftActive = false,
  onCancelGoalDraft,
  isStreaming = false,
  onPause,
  onSubmit,
  sendButtonTestId = 'send-message-button',
  sendButtonLabel,
  leadingContext,
  sendKey = 'enter',
  followUpBehavior = 'queue',
}: ComposerToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  const modelChangePending = Boolean(
    activeModel &&
    (!selectedModel ||
      activeModel.name !== selectedModel.name ||
      activeModel.type !== selectedModel.type)
  )
  const activeModelLabel = activeModel?.displayName || activeModel?.name
  const selectedModelLabel =
    selectedModel?.displayName || selectedModel?.name || t('workbench.default_model', 'Default')
  const displayedSelectedModel =
    selectedModel ?? (activeModel?.compatibilityDisabled ? activeModel : null)
  const primarySendShortcut = sendKey === 'enter' ? 'Enter' : 'Command+Enter'
  const primaryBusyLabel =
    followUpBehavior === 'guide'
      ? t('workbench.guide_current_turn', '引导当前回复')
      : t('workbench.send_after_turn', '当前回复结束后发送')

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
      className={cn(
        'mt-auto flex min-h-8 min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 pt-1',
        className
      )}
    >
      <div
        data-composer-toolbar-group="features"
        className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1"
      >
        <AddContextMenu
          translate={t}
          disabled={disabled}
          onFileSelect={onFileSelect}
          onSetPlanMode={showExecutionTools && !planModeActive ? onSetPlanMode : undefined}
          onSetGoal={showExecutionTools ? onSetGoal : undefined}
          onConfigureSupervisor={showExecutionTools ? onConfigureSupervisor : undefined}
          supervisorEnabled={showExecutionTools && supervisorEnabled}
          supervisorPending={showExecutionTools && supervisorPending}
        />
        {renderFeatureMenus?.(compact)}
        {leadingContext}
        {goalDraftActive ? (
          <GoalDraftPill translate={t} onCancel={onCancelGoalDraft} />
        ) : planModeActive ? (
          <ComposerModePill
            translate={t}
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
      <div
        data-composer-toolbar-group="actions"
        className="ml-auto flex min-w-40 flex-1 items-center justify-end gap-1.5"
      >
        {showExecutionTools ? (
          <>
            <PermissionModeSelector
              translate={t}
              value={runtimePermissionMode(selectedModelOptions)}
              disabled={disabled}
              iconOnly
              onChange={mode => onSelectModelOption(RUNTIME_PERMISSION_MODE_OPTION, mode)}
            />
            {contextUsageIndicator}
            {modelSelectorOverride ??
              (isModelSelectionReady || models.length > 0 ? (
                renderModelSelector({
                  models: models,
                  selectedModel: displayedSelectedModel,
                  selectedModelOptions: selectedModelOptions,
                  nextTurn: isStreaming && modelChangePending,
                  openSignal: modelSelectorOpenSignal,
                  onOpenChange: onModelSelectorOpenChange,
                  disabled: disabled,
                  onSelectModel: onSelectModel,
                  onSelectModelAndOptions: onSelectModelAndOptions,
                  onSelectModelOption: onSelectModelOption,
                  onBlockedModelSelect: onBlockedModelSelect,
                  buttonClassName: 'opacity-90 hover:opacity-100',
                  maxClosedWidth: compact ? NARROW_MODEL_SELECTOR_MAX_WIDTH : undefined,
                })
              ) : (
                <div className="h-8 w-32 min-w-0 shrink" data-testid="model-selector-loading" />
              ))}
          </>
        ) : null}
        {workspaceMenu}
        {isStreaming && !canSend ? (
          <Tooltip
            label={t('workbench.pause_response', '暂停回复')}
            align="end"
            testId="composer-pause-tooltip"
          >
            <button
              type="button"
              data-composer-primary-action="true"
              data-testid="pause-response-button"
              onClick={onPause}
              disabled={disabled || !onPause}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-text-primary p-0 text-background hover:bg-text-primary/90"
              aria-label={t('workbench.pause_response', '暂停回复')}
            >
              <span className="h-3.5 w-3.5 rounded-sm bg-current" aria-hidden="true" />
            </button>
          </Tooltip>
        ) : isStreaming && canSend ? (
          <div className="flex shrink-0 items-center rounded-full bg-text-primary text-background">
            <Tooltip label={primaryBusyLabel} align="end" testId="composer-send-after-turn-tooltip">
              <button
                type="submit"
                data-composer-primary-action="true"
                data-testid={sendButtonTestId}
                onMouseDown={event => event.preventDefault()}
                className="flex h-8 w-8 items-center justify-center rounded-l-full hover:bg-text-primary/90"
                aria-label={primaryBusyLabel}
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </Tooltip>
            <ActionMenu
              ariaLabel={t('workbench.choose_send_mode', '选择发送方式')}
              testId="send-mode-menu-button"
              icon={ChevronDown}
              triggerClassName="flex h-8 w-7 items-center justify-center rounded-r-full border-l border-background/20 hover:bg-text-primary/90"
              items={[
                {
                  label: t('workbench.send_after_turn', '当前回复结束后发送'),
                  icon: Clock3,
                  testId: 'send-after-turn-option',
                  onSelect: () => onSubmit(),
                  shortcut: followUpBehavior === 'queue' ? primarySendShortcut : undefined,
                },
                {
                  label:
                    modelChangePending && activeModelLabel
                      ? t(
                          'workbench.guide_current_turn_with_model',
                          'Guide current response · {{model}}',
                          {
                            model: activeModelLabel,
                          }
                        )
                      : t('workbench.guide_current_turn', '引导当前回复'),
                  icon: CornerDownRight,
                  testId: 'guide-current-turn-option',
                  onSelect: () => onSubmit({ guideWhenBusy: true }),
                  shortcut: followUpBehavior === 'guide' ? primarySendShortcut : undefined,
                },
                {
                  label:
                    modelChangePending && selectedModelLabel
                      ? t(
                          'workbench.interrupt_and_send_with_model',
                          'Interrupt and use {{model}}',
                          {
                            model: selectedModelLabel,
                          }
                        )
                      : t('workbench.interrupt_and_send', '打断并立即发送'),
                  icon: Zap,
                  testId: 'interrupt-and-send-option',
                  onSelect: () => onSubmit({ interruptWhenBusy: true }),
                  shortcut: 'Command+Shift+Enter',
                },
              ]}
            />
          </div>
        ) : (
          <Tooltip
            label={sendButtonLabel ?? t('workbench.send_message', '发送消息')}
            align="end"
            testId="composer-send-tooltip"
          >
            <button
              type="submit"
              data-composer-primary-action="true"
              data-testid={sendButtonTestId}
              disabled={!canSend}
              onMouseDown={event => event.preventDefault()}
              className={cn(
                'flex h-8 shrink-0 items-center justify-center gap-1.5 bg-text-primary text-background disabled:cursor-not-allowed disabled:bg-text-muted/45',
                sendButtonLabel ? 'rounded-lg px-3 text-sm font-medium' : 'w-8 rounded-full p-0'
              )}
              aria-label={sendButtonLabel ?? t('workbench.send_message', '发送消息')}
            >
              {sendButtonLabel}
              <ArrowUp className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
