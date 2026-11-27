import type { ModelOptions, UnifiedModel } from '@wegent/chat-core/models'
import { ChevronDown, ClipboardList, Clock3, CornerDownRight, Zap } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { composerActionDensity, composerIconActionDensity } from '../controls/recipes'
import { ActionMenu } from '../controls/ActionMenu'
import type { CollaborationTranslate } from '../i18n'
import { Tooltip } from '../controls/Tooltip'
import { Button as ControlButton } from '../markdown/Button'
import type { ComposerFollowUpBehavior, ComposerSubmitOptions } from './composerInputTypes'

import { AddContextMenu } from './AddContextMenu'
import {
  ComposerSendButton,
  ComposerSendGroup,
  composerSendMenuClassName,
} from './ComposerSendButton'
import { ComposerModePill, GoalDraftPill } from './GoalDraftPill'

import type { ModelSelectorCloseReason } from '../controls/model-selector-types'

import {
  RUNTIME_COMMAND_APPROVAL_OPTION,
  RUNTIME_PERMISSION_MODE_OPTION,
  runtimeCommandApprovalMode,
  runtimePermissionMode,
} from '@wegent/chat-core/runtime-permission'
import {
  PermissionModeSelector,
  type ComposerPermissionControls,
} from '../controls/PermissionModeSelector'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export interface ComposerToolbarProps {
  translate: CollaborationTranslate
  hideFeatureActions?: boolean
  renderFeatureMenus?: (compact: boolean, permissionSelector: ReactNode) => ReactNode
  renderTrailingActions?: (compact: boolean) => ReactNode
  contextUsageIndicator?: ReactNode
  workspaceMenu?: ReactNode
  renderModelSelector: (
    props: import('../controls/model-selector-types').ModelSelectorProps
  ) => ReactNode
  className?: string
  canSend: boolean
  disabled?: boolean
  showModelSelector?: boolean
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
  onSelectPermissionOptions?: (options: ModelOptions) => void
  permissionControls?: ComposerPermissionControls | null
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  modelSelectorOverride?: ReactNode
  onFileSelect: (files: File | File[]) => void
  onDraw?: () => void
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
  showPauseButton?: boolean
  onPause?: () => void
  onSubmit: (options?: ComposerSubmitOptions) => void
  sendButtonTestId?: string
  sendButtonLabel?: string
  showSubmitButton?: boolean
  showAttachmentActions?: boolean
  leadingContext?: ReactNode
  sendKey?: 'enter' | 'cmd_enter'
  followUpBehavior?: ComposerFollowUpBehavior
}

const COMPACT_TOOLBAR_WIDTH = 475

export function ComposerToolbar({
  translate: t,
  renderFeatureMenus,
  renderTrailingActions,
  hideFeatureActions = false,
  contextUsageIndicator,
  workspaceMenu,
  renderModelSelector,
  className,
  canSend,
  disabled = false,
  showExecutionTools = true,
  showModelSelector = showExecutionTools,
  models,
  selectedModel,
  activeModel,
  selectedModelOptions,
  modelSelectorOpenSignal,
  onModelSelectorOpenChange,
  onSelectModel,
  onSelectModelAndOptions,
  onSelectModelOption,
  onSelectPermissionOptions,
  permissionControls,
  onBlockedModelSelect,
  modelSelectorOverride,
  onFileSelect,
  onDraw,
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
  showPauseButton = true,
  onPause,
  onSubmit,
  sendButtonTestId = 'send-message-button',
  sendButtonLabel,
  showSubmitButton = true,
  showAttachmentActions = true,
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
    selectedModel?.displayName ||
    selectedModel?.name ||
    t('workbench.model_picker_title', 'Select model')
  const displayedSelectedModel =
    selectedModel ?? (activeModel?.compatibilityDisabled ? activeModel : null)
  const primarySendShortcut = sendKey === 'enter' ? 'Enter' : 'mod+Enter'
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

  const selectedPermissionControls: ComposerPermissionControls | null =
    permissionControls === undefined
      ? {
          value: runtimePermissionMode(selectedModelOptions),
          commandApproval: runtimeCommandApprovalMode(selectedModelOptions),
          onCommandApprovalChange: mode =>
            onSelectModelOption(RUNTIME_COMMAND_APPROVAL_OPTION, mode),
          onChange: (mode, approval) => {
            if (onSelectPermissionOptions) {
              onSelectPermissionOptions({
                [RUNTIME_PERMISSION_MODE_OPTION]: mode,
                ...(approval ? { [RUNTIME_COMMAND_APPROVAL_OPTION]: approval } : {}),
              })
              return
            }
            if (approval) onSelectModelOption(RUNTIME_COMMAND_APPROVAL_OPTION, approval)
            onSelectModelOption(RUNTIME_PERMISSION_MODE_OPTION, mode)
          },
        }
      : permissionControls
  const permissionSelector =
    showExecutionTools && selectedPermissionControls ? (
      <PermissionModeSelector
        translate={t}
        iconOnly
        density="dense"
        {...selectedPermissionControls}
        disabled={disabled || selectedPermissionControls.disabled}
      />
    ) : null

  return (
    <div
      ref={toolbarRef}
      data-testid="composer-toolbar"
      data-compact={compact ? 'true' : 'false'}
      className={cn(
        'mt-auto flex min-h-7 min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 pt-1 max-md:min-h-11 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11',
        className
      )}
    >
      <div
        data-composer-toolbar-group="features"
        className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1"
      >
        {!hideFeatureActions && (
          <AddContextMenu
            translate={t}
            disabled={disabled}
            onFileSelect={onFileSelect}
            onDraw={showAttachmentActions ? onDraw : undefined}
            showAttachmentActions={showAttachmentActions}
            onSetPlanMode={showExecutionTools && !planModeActive ? onSetPlanMode : undefined}
            onSetGoal={showExecutionTools || !showAttachmentActions ? onSetGoal : undefined}
            onConfigureSupervisor={showExecutionTools ? onConfigureSupervisor : undefined}
            supervisorEnabled={showExecutionTools && supervisorEnabled}
            supervisorPending={showExecutionTools && supervisorPending}
          />
        )}
        {renderFeatureMenus ? renderFeatureMenus(compact, permissionSelector) : permissionSelector}
        {!hideFeatureActions && (
          <>
            {leadingContext && (
              <div
                data-testid="composer-toolbar-context"
                className="flex min-w-0 max-w-full flex-wrap items-center gap-1"
              >
                {leadingContext}
              </div>
            )}
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
          </>
        )}
      </div>
      <div
        data-composer-toolbar-group="actions"
        className="ml-auto flex min-w-40 flex-1 items-center justify-end gap-1.5"
      >
        {showExecutionTools ? contextUsageIndicator : null}
        {showModelSelector
          ? (modelSelectorOverride ??
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
              buttonClassName: composerActionDensity + ' md:min-w-7 opacity-90 hover:opacity-100',
            }))
          : null}
        {workspaceMenu}
        {renderTrailingActions?.(compact)}
        {showSubmitButton &&
          (showPauseButton && isStreaming && !canSend ? (
            <Tooltip
              label={t('workbench.pause_response', '暂停回复')}
              align="end"
              testId="composer-pause-tooltip"
            >
              <ControlButton
                variant="primary"
                size="sm"
                type="button"
                data-composer-primary-action="true"
                data-testid="pause-response-button"
                onClick={onPause}
                disabled={disabled || !onPause}
                className={
                  composerIconActionDensity +
                  ' flex shrink-0 items-center justify-center rounded-full bg-text-primary text-background hover:bg-text-primary/90'
                }
                aria-label={t('workbench.pause_response', '暂停回复')}
              >
                <span className="h-3.5 w-3.5 rounded-sm bg-current" aria-hidden="true" />
              </ControlButton>
            </Tooltip>
          ) : isStreaming && canSend ? (
            <ComposerSendGroup>
              <ComposerSendButton
                label={primaryBusyLabel}
                testId={sendButtonTestId}
                tooltipTestId="composer-send-after-turn-tooltip"
                disabled={false}
                split
              />
              <ActionMenu
                density="dense"
                ariaLabel={t('workbench.choose_send_mode', '选择发送方式')}
                testId="send-mode-menu-button"
                icon={ChevronDown}
                triggerClassName={composerSendMenuClassName}
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
                    shortcut: 'mod+Shift+Enter',
                  },
                ]}
              />
            </ComposerSendGroup>
          ) : (
            <ComposerSendButton
              label={sendButtonLabel ?? t('workbench.send_message', '发送消息')}
              text={sendButtonLabel}
              testId={sendButtonTestId}
              tooltipTestId="composer-send-tooltip"
              disabled={!canSend}
            />
          ))}
      </div>
    </div>
  )
}
