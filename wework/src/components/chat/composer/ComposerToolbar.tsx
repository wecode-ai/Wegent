import { ComposerToolbar as SharedComposerToolbar } from '@wegent/collaboration/composer'

import { useCallback, useState, type ComponentProps, type ReactNode } from 'react'

import type { ComposerSubmitOptions } from './ComposerTextarea'
import type { ComposerFollowUpBehavior } from './composerTextareaTypes'
import { useTranslation } from '@/hooks/useTranslation'

import type { LocalDeviceApp, ModelOptions, RuntimeContextUsage, UnifiedModel } from '@/types/api'
import type { WorkspaceTarget } from '@/types/workspace-files'

import { ContextUsageIndicator } from './ContextUsageIndicator'
import { ModelSelector } from './ModelSelector'
import type { ModelSelectorCloseReason } from '@wegent/collaboration/controls/model-selector-types'
import { PluginPickerMenu } from './PluginPickerMenu'
import { PopoutWorkspaceMenu } from './PopoutWorkspaceMenu'
import { QuickPhraseMenu } from './QuickPhraseMenu'
import type { QuickPhrase } from '@/desktop/appPreferences'
import { useComposerDrawing } from './useComposerDrawing'

import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { DshMenuActions } from '@/features/dsh-runtime/DshMenuActions'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'

interface ComposerToolbarProps {
  composerScopeKey?: string
  captureInsertion?(): { insertText(text: string): boolean } | null
  className?: string
  canSend: boolean
  disabled?: boolean
  pluginPickerIconOnly?: boolean
  showModelSelector?: boolean
  showExecutionTools?: boolean
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  activeModel?: UnifiedModel | null
  selectedModelOptions: ModelOptions
  modelSelectorOpenSignal?: number
  onModelSelectorOpenChange?: (open: boolean, closeReason?: ModelSelectorCloseReason) => void
  isModelSelectionReady: boolean
  contextUsage?: RuntimeContextUsage
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
  showWorkspaceMenu?: boolean
  projectWorkMenuContext?: Omit<ComponentProps<typeof PopoutWorkspaceMenu>, 'disabled'>
  projectPhrases?: QuickPhrase[]
  onQuickPhraseSelect: (phrase: QuickPhrase) => void
  onInsertPluginReference: (reference: string) => void
  onSubmit: (options?: ComposerSubmitOptions) => void
  sendButtonTestId?: string
  sendButtonLabel?: string
  showSubmitButton?: boolean
  showAttachmentActions?: boolean
  leadingContext?: ReactNode
  onListLocalApps?: () => Promise<LocalDeviceApp[]>
  workspaceTarget?: WorkspaceTarget | null
  sendKey?: 'enter' | 'cmd_enter'
  followUpBehavior?: ComposerFollowUpBehavior
}

export function ComposerToolbar(props: ComposerToolbarProps) {
  const { t } = useTranslation('common')
  const [voiceActivity, setVoiceActivity] = useState({
    scope: props.composerScopeKey,
    active: false,
  })
  const voiceActive = voiceActivity.scope === props.composerScopeKey && voiceActivity.active
  const onVoiceActiveChange = useCallback(
    (active: boolean) => setVoiceActivity({ scope: props.composerScopeKey, active }),
    [props.composerScopeKey]
  )
  const {
    disabled = false,
    showExecutionTools = true,
    pluginPickerIconOnly = false,
    onListLocalApps,
    projectPhrases = [],
    onQuickPhraseSelect,
    workspaceTarget,
  } = props
  const { openDrawing, drawingDialog } = useComposerDrawing(props.onFileSelect, disabled)
  return (
    <>
      {drawingDialog}
      <SharedComposerToolbar
        {...props}
        hideFeatureActions={voiceActive}
        onDraw={openDrawing}
        translate={(key, fallback, options) => t(key, fallback ?? key, options)}
        renderModelSelector={modelProps => <ModelSelector {...modelProps} />}
        contextUsageIndicator={
          <ContextUsageIndicator
            usage={props.contextUsage}
            disabled={disabled}
            onCompactContext={props.onCompactContext}
          />
        }
        workspaceMenu={
          props.showWorkspaceMenu && props.projectWorkMenuContext ? (
            <PopoutWorkspaceMenu {...props.projectWorkMenuContext} disabled={disabled} />
          ) : null
        }
        renderFeatureMenus={compact => (
          <>
            <div hidden={voiceActive} className={voiceActive ? 'hidden' : 'contents'}>
              <DshMenuActions disabled={disabled} location="composer.toolbar" />
            </div>
            <div className="contents" data-testid="composer-extension-actions">
              <DshContributionSlotSurface
                key={props.composerScopeKey}
                entryId={voiceActive ? 'voice-input' : undefined}
                attachedClassName="contents"
                props={{
                  compact,
                  onActiveChange: onVoiceActiveChange,
                  disabled,
                  workspaceTarget,
                  captureInsertion: props.captureInsertion,
                  sessionId: props.composerScopeKey,
                }}
                slot={WEWORK_DSH_SLOTS.composerAction}
              />
            </div>
            <div hidden={voiceActive} className={voiceActive ? 'hidden' : 'contents'}>
              {showExecutionTools ? (
                <>
                  <QuickPhraseMenu
                    disabled={disabled}
                    projectPhrases={projectPhrases}
                    onSelect={onQuickPhraseSelect}
                  />
                  <PluginPickerMenu
                    disabled={disabled}
                    iconOnly={compact || pluginPickerIconOnly}
                    onListLocalApps={onListLocalApps}
                    onInsertReference={props.onInsertPluginReference}
                  />
                </>
              ) : null}
            </div>
          </>
        )}
      />
    </>
  )
}
