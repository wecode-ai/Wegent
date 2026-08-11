import { ArrowUp, ChevronDown, ClipboardList, Clock3, CornerDownRight, Zap } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import type { CloudProject } from '@/api/deliveries'
import { ActionMenu } from '@/components/common/ActionMenu'
import type { ComposerSubmitOptions } from './ComposerTextarea'
import { useTranslation } from '@/hooks/useTranslation'
import { Tooltip } from '@/components/ui/tooltip'
import type { LocalDeviceApp, ModelOptions, RuntimeContextUsage, UnifiedModel } from '@/types/api'
import { AddContextMenu } from './AddContextMenu'
import type { ComposerCloudMentionCandidate } from './composerMentionCandidates'
import { ComposerModePill, GoalDraftPill } from './GoalDraftPill'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import { ModelSelector } from './ModelSelector'
import { PluginPickerMenu } from './PluginPickerMenu'
import { PopoutWorkspaceMenu } from './PopoutWorkspaceMenu'
import { QuickPhraseMenu } from './QuickPhraseMenu'
import type { QuickPhrase } from '@/tauri/appPreferences'

interface ComposerToolbarProps {
  canSend: boolean
  disabled?: boolean
  pluginPickerIconOnly?: boolean
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  activeModel?: UnifiedModel | null
  selectedModelOptions: ModelOptions
  modelSelectorOpenSignal?: number
  onModelSelectorOpenChange?: (open: boolean) => void
  isModelSelectionReady: boolean
  contextUsage?: RuntimeContextUsage
  onSelectModel: (model: UnifiedModel | null) => void
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
  showWorkspaceMenu?: boolean
  projectWorkMenuContext?: Omit<ComponentProps<typeof PopoutWorkspaceMenu>, 'disabled'>
  onQuickPhraseSelect: (phrase: QuickPhrase) => void
  onSubmit: (options?: ComposerSubmitOptions) => void
  sendButtonTestId?: string
  leadingContext?: ReactNode
  onListLocalApps?: () => Promise<LocalDeviceApp[]>
  cloudProjectCandidates?: ComposerCloudMentionCandidate[]
  selectedCloudProjectId?: CloudProject['id']
  onSelectCloudProject?: (project: CloudProject) => void
}

const COMPACT_TOOLBAR_WIDTH = 475
const NARROW_MODEL_SELECTOR_MAX_WIDTH = 160

export function ComposerToolbar({
  canSend,
  disabled = false,
  pluginPickerIconOnly = false,
  models,
  selectedModel,
  activeModel,
  selectedModelOptions,
  modelSelectorOpenSignal,
  onModelSelectorOpenChange,
  isModelSelectionReady,
  contextUsage,
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
  onCompactContext,
  goalDraftActive = false,
  onCancelGoalDraft,
  isStreaming = false,
  onPause,
  showWorkspaceMenu,
  projectWorkMenuContext,
  onQuickPhraseSelect,
  onSubmit,
  sendButtonTestId = 'send-message-button',
  leadingContext,
  onListLocalApps,
  cloudProjectCandidates,
  selectedCloudProjectId,
  onSelectCloudProject,
}: ComposerToolbarProps) {
  const { t } = useTranslation('common')
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
          onConfigureSupervisor={onConfigureSupervisor}
          supervisorEnabled={supervisorEnabled}
          supervisorPending={supervisorPending}
          cloudProjectCandidates={cloudProjectCandidates}
          selectedCloudProjectId={selectedCloudProjectId}
          onSelectCloudProject={onSelectCloudProject}
        />
        <QuickPhraseMenu disabled={disabled} onSelect={onQuickPhraseSelect} />
        <PluginPickerMenu
          disabled={disabled}
          iconOnly={compact || pluginPickerIconOnly}
          onListLocalApps={onListLocalApps}
        />
        {leadingContext}
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
        <ContextUsageIndicator
          usage={contextUsage}
          disabled={disabled}
          onCompactContext={onCompactContext}
        />
        {modelSelectorOverride ??
          (isModelSelectionReady ? (
            <ModelSelector
              models={models}
              selectedModel={selectedModel}
              selectedModelOptions={selectedModelOptions}
              nextTurn={isStreaming && modelChangePending}
              openSignal={modelSelectorOpenSignal}
              onOpenChange={onModelSelectorOpenChange}
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
          ))}
        {showWorkspaceMenu && projectWorkMenuContext ? (
          <PopoutWorkspaceMenu {...projectWorkMenuContext} disabled={disabled} />
        ) : null}
        {isStreaming && !canSend ? (
          <Tooltip
            label={t('workbench.pause_response', '暂停回复')}
            align="end"
            testId="composer-pause-tooltip"
          >
            <button
              type="button"
              data-testid="pause-response-button"
              onClick={onPause}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1f1f1f] p-0 text-white hover:bg-[#333]"
              aria-label={t('workbench.pause_response', '暂停回复')}
            >
              <span className="h-3.5 w-3.5 rounded-sm bg-current" aria-hidden="true" />
            </button>
          </Tooltip>
        ) : isStreaming && canSend ? (
          <div className="flex items-center rounded-full bg-[#1f1f1f] text-white">
            <Tooltip
              label={t('workbench.send_after_turn', '当前回复结束后发送')}
              align="end"
              testId="composer-send-after-turn-tooltip"
            >
              <button
                type="submit"
                data-testid={sendButtonTestId}
                className="flex h-8 w-8 items-center justify-center rounded-l-full hover:bg-[#333]"
                aria-label={t('workbench.send_after_turn', '当前回复结束后发送')}
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </Tooltip>
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
                  shortcut: 'Enter',
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
                  shortcut: 'Command+Enter',
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
            label={t('workbench.send_message', '发送消息')}
            align="end"
            testId="composer-send-tooltip"
          >
            <button
              type="submit"
              data-testid={sendButtonTestId}
              disabled={!canSend}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1f1f1f] p-0 text-white disabled:cursor-not-allowed disabled:bg-text-muted/45 disabled:text-background"
              aria-label={t('workbench.send_message', '发送消息')}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
