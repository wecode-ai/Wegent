import { useStableEvent } from '@/features/workbench/useStableEvent'
import type { CloudProject } from '@/api/deliveries'
import { ActionMenu } from '@/components/common/ActionMenu'
import type { QuickPhrase } from '@/desktop/appPreferences'
import {
  RUNTIME_COMMAND_APPROVAL_OPTION,
  RUNTIME_PERMISSION_MODE_OPTION,
  runtimeCommandApprovalMode,
  runtimePermissionMode,
} from '@/features/workbench/runtimePermissionMode'
import { useTranslation } from '@/hooks/useTranslation'
import { resolveStoredWorkspacePaths } from '@/lib/workspace-path-transfer'
import type {
  Attachment,
  LocalDeviceApp,
  LocalDeviceSkill,
  ModelOptions,
  UnifiedModel,
} from '@/types/api'
import type { CodeCommentContext, WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import { ComposerErrorBanner } from '@wegent/collaboration/composer'
import type { ComposerPermissionControls } from '@wegent/collaboration/controls'
import { applyQuickPhrase } from '@wegent/collaboration/composer/applyQuickPhrase'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { useElementGeometry } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import {
  ArrowUp,
  Camera,
  ChevronDown,
  ClipboardList,
  Clock3,
  CornerDownRight,
  Image,
  Maximize2,
  Minimize2,
  PencilLine,
  Plus,
  ShieldCheck,
  Square,
  Target,
  Zap,
} from 'lucide-react'
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import { AttachmentBadges } from './AttachmentBadges'
import { debugComposerEvent, textMetrics } from './composerDebug'
import type {
  ComposerCloudMentionCandidate,
  ComposerConversationMentionCandidate,
} from './composerMentionCandidates'
import { applyWorkspacePathTransfer } from './composerPathTransfer'
import {
  ComposerTextarea,
  type ComposerSubmitOptions,
  type ComposerTextareaHandle,
} from './ComposerTextarea'
import {
  primaryComposerSubmitOptions,
  type ComposerFollowUpBehavior,
} from './composerTextareaTypes'
import { ComposerModePill, GoalDraftPill } from './GoalDraftPill'
import { ModelSelector } from './ModelSelector'
import { PermissionModeSelector } from './PermissionModeSelector'
import { QuickPhraseMenu } from './QuickPhraseMenu'
import { useAutoResizeTextarea } from './useAutoResizeTextarea'
import { useComposerDrawing } from './useComposerDrawing'
import { useComposerModelSelector } from './useComposerModelSelector'

interface CompactChatComposerProps {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  onCompositionStart?: () => void
  onCompositionEnd?: () => void
  onSubmit: (submittedValue?: string, options?: ComposerSubmitOptions) => void
  disabled: boolean
  submitDisabled?: boolean
  disabledReason?: string
  placeholder: string
  inputTestId?: string
  submitButtonTestId?: string
  showSubmitButton?: boolean
  showAttachmentActions?: boolean
  attachments?: Attachment[]
  codeComments?: CodeCommentContext[]
  uploadingFiles?: Map<string, { file: File; progress: number }>
  attachmentErrors?: Map<string, string>
  onDismissAttachmentError?: (filename: string) => void
  onFileSelect?: (files: File | File[]) => void
  onOpenSkillFile?: (path: string) => void
  workspaceTarget?: WorkspaceTarget | null
  workspaceFileApi?: WorkspaceFileApi
  cloudMentionCandidates?: ComposerCloudMentionCandidate[]
  conversationMentionCandidates?: ComposerConversationMentionCandidate[]
  cloudProjectCandidates?: ComposerCloudMentionCandidate[]
  cloudSpaceEnabled?: boolean
  onSelectCloudProject?: (project: CloudProject) => void
  planModeActive?: boolean
  onSetPlanMode?: () => void
  onClearPlanMode?: () => void
  onSetGoal?: () => void
  goalDraftActive?: boolean
  onCancelGoalDraft?: () => void
  onRemoveAttachment?: (attachmentId: number) => void
  onClearCodeComments?: () => void
  onListLocalSkills?: () => Promise<LocalDeviceSkill[]>
  onListLocalApps?: () => Promise<LocalDeviceApp[]>
  models?: UnifiedModel[]
  selectedModel?: UnifiedModel | null
  activeModel?: UnifiedModel | null
  selectedModelOptions?: ModelOptions
  permissionControls?: ComposerPermissionControls | null
  onSelectModel?: (model: UnifiedModel | null) => boolean | void
  onSelectModelOption?: (optionId: string, value: string) => void
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  modelSelectorOverride?: ReactNode
  isModelSelectionReady?: boolean
  isStreaming?: boolean
  showPauseButton?: boolean
  onPause?: () => void
  projectPhrases?: QuickPhrase[]
  sendKey?: 'enter' | 'cmd_enter'
  followUpBehavior?: ComposerFollowUpBehavior
}

export const CompactChatComposer = forwardRef<ComposerTextareaHandle, CompactChatComposerProps>(
  function CompactChatComposer(
    {
      value,
      onChange,
      onBlur,
      onCompositionStart,
      onCompositionEnd,
      onSubmit,
      disabled,
      submitDisabled = false,
      disabledReason,
      placeholder,
      inputTestId,
      submitButtonTestId = 'send-message-button',
      showSubmitButton = true,
      showAttachmentActions = true,
      attachments = [],
      codeComments = [],
      uploadingFiles = new Map(),
      attachmentErrors = new Map(),
      onDismissAttachmentError,
      onFileSelect,
      onOpenSkillFile,
      workspaceTarget,
      workspaceFileApi,
      cloudMentionCandidates,
      conversationMentionCandidates,
      cloudProjectCandidates,
      cloudSpaceEnabled,
      onSelectCloudProject,
      planModeActive = false,
      onSetPlanMode,
      onClearPlanMode,
      onSetGoal,
      goalDraftActive = false,
      onCancelGoalDraft,
      onRemoveAttachment = () => {},
      onClearCodeComments,
      onListLocalSkills,
      onListLocalApps,
      models = [],
      selectedModel,
      activeModel,
      selectedModelOptions = {},
      permissionControls,
      onSelectModel,
      onSelectModelOption,
      onBlockedModelSelect,
      modelSelectorOverride,
      isModelSelectionReady = true,
      isStreaming = false,
      showPauseButton = true,
      onPause,
      projectPhrases,
      sendKey = 'enter',
      followUpBehavior = 'queue',
    },
    ref
  ) {
    const { t } = useTranslation('common')
    const { openDrawing, drawingDialog } = useComposerDrawing(onFileSelect, disabled)
    const imageInputRef = useRef<HTMLInputElement>(null)
    const cameraInputRef = useRef<HTMLInputElement>(null)
    const composerRef = useRef<ComposerTextareaHandle>(null)
    const modelSelectorControl = useComposerModelSelector()
    const fullscreenModelSelectorControl = useComposerModelSelector()
    const fullscreenComposerRef = useRef<ComposerTextareaHandle>(null)
    const textareaRef = useAutoResizeTextarea(value, 128)
    const fullscreenInputRef = useRef<HTMLElement>(null)
    const [contextSheetOpen, setContextSheetOpen] = useState(false)
    const [fullscreenInputOpen, setFullscreenInputOpen] = useState(false)
    const geometry = useElementGeometry([textareaRef])
    const [textState, setTextState] = useState({
      external: value,
      hasText: value.trim().length > 0,
    })
    if (textState.external !== value)
      setTextState({ external: value, hasText: value.trim().length > 0 })
    const hasText = textState.hasText
    const [phraseError, setPhraseError] = useState<string | null>(null)
    const selectedPermissionControls: ComposerPermissionControls | null | undefined =
      permissionControls === undefined && onSelectModelOption
        ? {
            value: runtimePermissionMode(selectedModelOptions),
            commandApproval: runtimeCommandApprovalMode(selectedModelOptions),
            onCommandApprovalChange: mode =>
              onSelectModelOption(RUNTIME_COMMAND_APPROVAL_OPTION, mode),
            onChange: (mode, approval) => {
              if (approval) onSelectModelOption(RUNTIME_COMMAND_APPROVAL_OPTION, approval)
              onSelectModelOption(RUNTIME_PERMISSION_MODE_OPTION, mode)
            },
          }
        : permissionControls

    useImperativeHandle(
      ref,
      () => ({
        get element() {
          const activeHandle = fullscreenInputOpen
            ? fullscreenComposerRef.current
            : composerRef.current
          return activeHandle?.element ?? null
        },
        focus: () => {
          const activeHandle = fullscreenInputOpen
            ? fullscreenComposerRef.current
            : composerRef.current
          activeHandle?.focus()
        },
        getValue: () => {
          const activeHandle = fullscreenInputOpen
            ? fullscreenComposerRef.current
            : composerRef.current
          return activeHandle?.getValue() ?? value
        },
        insertReference: reference => {
          const activeHandle = fullscreenInputOpen
            ? fullscreenComposerRef.current
            : composerRef.current
          activeHandle?.insertReference(reference)
        },
        setValue: (nextValue, selectionOffset) => {
          const activeHandle = fullscreenInputOpen
            ? fullscreenComposerRef.current
            : composerRef.current
          activeHandle?.setValue(nextValue, selectionOffset)
        },
      }),
      [fullscreenInputOpen, value]
    )
    const getLiveValue = () => composerRef.current?.getValue() ?? value
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
      t('workbench.model_picker_title', '选择模型')
    const primarySendShortcut = sendKey === 'enter' ? 'Enter' : 'Command+Enter'
    const primaryBusyLabel =
      followUpBehavior === 'guide'
        ? t('workbench.guide_current_turn', '引导当前回复')
        : t('workbench.send_after_turn', '当前回复结束后发送')
    const canSend =
      (hasText || attachments.length > 0 || codeComments.length > 0) &&
      isModelSelectionReady &&
      !disabled &&
      !submitDisabled
    const explicitLineCount = value.split('\n').length

    const handleComposerChange = useCallback(
      (nextValue: string) => {
        setTextState(current => ({ ...current, hasText: nextValue.trim().length > 0 }))
        onChange(nextValue)
      },
      [onChange]
    )

    const handleShowTextAttachment = (attachment: Attachment) => {
      const text = attachment.text_content
      if (!text) return

      const currentValue = getLiveValue()
      const nextValue = currentValue ? `${currentValue}\n${text}` : text
      handleComposerChange(nextValue)
      onRemoveAttachment(attachment.id)
      window.requestAnimationFrame(() => textareaRef.current?.focus())
    }
    const handleQuickPhraseSelect = useStableEvent((phrase: QuickPhrase) => {
      const activeComposer = fullscreenInputOpen
        ? fullscreenComposerRef.current
        : composerRef.current
      if (!activeComposer) return
      setPhraseError(null)
      applyQuickPhrase(phrase, activeComposer, {
        clearPlan: onClearPlanMode,
        cancelGoal: onCancelGoalDraft,
        setPlan: onSetPlanMode,
        setGoal: onSetGoal,
      })
      if (phrase.attachmentPaths?.length && onFileSelect) {
        void resolveStoredWorkspacePaths(
          phrase.attachmentPaths,
          workspaceTarget?.workspaceSource === 'remote'
        )
          .then(transfer =>
            applyWorkspacePathTransfer(getLiveValue(), transfer, handleComposerChange, onFileSelect)
          )
          .catch(cause => setPhraseError(cause instanceof Error ? cause.message : String(cause)))
      }
    })

    const handleImageChange = (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      if (files && files.length > 0) {
        onFileSelect?.(Array.from(files))
      }
      event.target.value = ''
      setContextSheetOpen(false)
    }

    const handleSetGoal = () => {
      setContextSheetOpen(false)
      onSetGoal?.()
    }

    const handleSetPlanMode = () => {
      setContextSheetOpen(false)
      onSetPlanMode?.()
    }

    const canExpandInput = explicitLineCount > 4 || (geometry?.elements[0]?.scrollHeight ?? 0) > 124

    const renderModelSelector = (control: ReturnType<typeof useComposerModelSelector>) => (
      <ModelSelector
        openSignal={control.openSignal}
        onOpenChange={control.onOpenChange}
        models={models}
        selectedModel={selectedModel ?? null}
        selectedModelOptions={selectedModelOptions}
        disabled={disabled || !onSelectModel}
        onSelectModel={onSelectModel ?? (() => {})}
        onSelectModelOption={onSelectModelOption ?? (() => {})}
        onBlockedModelSelect={onBlockedModelSelect}
        nextTurn={isStreaming && modelChangePending}
      />
    )

    return (
      <div className="w-full">
        {drawingDialog}
        <ComposerErrorBanner error={phraseError} />
        <AttachmentBadges
          workspacePath={workspaceTarget?.path}
          attachments={attachments}
          uploadingFiles={uploadingFiles}
          errors={attachmentErrors}
          onDismissAttachmentError={onDismissAttachmentError}
          codeComments={codeComments}
          onRemoveAttachment={onRemoveAttachment}
          onShowTextAttachment={handleShowTextAttachment}
          onClearCodeComments={onClearCodeComments}
        />
        <ControlInput
          ref={imageInputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="mobile-image-file-input"
          onChange={handleImageChange}
        />
        <ControlInput
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          data-testid="mobile-camera-file-input"
          onChange={handleImageChange}
        />
        {disabledReason && (
          <div
            data-testid="composer-disabled-reason"
            className="mb-2 rounded-xl bg-muted px-3 py-2 text-xs text-text-secondary"
          >
            {disabledReason}
          </div>
        )}
        {goalDraftActive ? (
          <GoalDraftPill onCancel={onCancelGoalDraft} className="mb-2" />
        ) : planModeActive ? (
          <ComposerModePill
            label={t('workbench.plan_mode', '计划模式')}
            icon={ClipboardList}
            testId="plan-mode-pill"
            cancelTestId="cancel-plan-mode-button"
            cancelLabel={t('workbench.disable_plan_mode', '关闭计划模式')}
            onCancel={onClearPlanMode}
            className="mb-2"
            title={t('workbench.collaboration_mode', '运行模式')}
          />
        ) : null}
        {!fullscreenInputOpen &&
          (modelSelectorOverride === undefined ? (
            <div className="mb-2 flex min-w-0 justify-end">
              {renderModelSelector(modelSelectorControl)}
            </div>
          ) : (
            modelSelectorOverride
          ))}
        <form
          className="flex w-full items-end gap-2"
          onSubmit={event => {
            event.preventDefault()
            const submittedValue = composerRef.current?.getValue() ?? value
            debugComposerEvent('compact-form-submit', {
              canSend,
              propValue: textMetrics(value),
              submittedValue: textMetrics(submittedValue),
              attachmentsCount: attachments.length,
              codeCommentsCount: codeComments.length,
              disabled,
            })
            if (canSend) {
              const options = primaryComposerSubmitOptions(isStreaming, followUpBehavior)
              if (options) {
                onSubmit(submittedValue, options)
              } else {
                onSubmit(submittedValue)
              }
            }
          }}
        >
          {showAttachmentActions && (
            <ControlButton
              variant="outline"
              size="sm"
              type="button"
              data-testid="add-context-button"
              onClick={() => !disabled && setContextSheetOpen(true)}
              disabled={disabled}
              className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[26px] border border-border bg-background p-0 text-text-secondary shadow-[0_8px_28px_rgba(0,0,0,0.08)] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              aria-expanded={contextSheetOpen}
              aria-label={t('workbench.add_context', '添加上下文')}
            >
              <Plus className="h-6 w-6" />
            </ControlButton>
          )}
          <QuickPhraseMenu
            compact
            disabled={disabled}
            projectPhrases={projectPhrases}
            onSelect={handleQuickPhraseSelect}
          />
          <div
            data-testid="compact-input-pill"
            className={[
              'relative flex min-h-[52px] min-w-0 flex-1 items-end rounded-[26px] border border-border bg-background pl-4 shadow-[0_12px_40px_rgba(0,0,0,0.08)]',
              'z-chrome',
              isStreaming && canSend ? 'pr-[92px]' : 'pr-14',
            ].join(' ')}
          >
            <ComposerTextarea
              ref={composerRef}
              onOpenModelSelector={
                modelSelectorOverride === undefined ? modelSelectorControl.requestOpen : undefined
              }
              modelSelectorOpen={modelSelectorControl.open}
              testId={inputTestId}
              textareaRef={textareaRef}
              value={value}
              onChange={handleComposerChange}
              onBlur={onBlur}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              onSubmit={onSubmit}
              canSend={canSend}
              placeholder={placeholder}
              rows={1}
              onPasteFiles={files => onFileSelect?.(files)}
              onOpenSkillFile={onOpenSkillFile}
              workspaceTarget={workspaceTarget}
              workspaceFileApi={workspaceFileApi}
              cloudMentionCandidates={cloudMentionCandidates}
              conversationMentionCandidates={conversationMentionCandidates}
              cloudProjectCandidates={cloudProjectCandidates}
              cloudSpaceEnabled={cloudSpaceEnabled}
              onSelectCloudProject={onSelectCloudProject}
              className="scrollbar-none max-h-32 min-h-6 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-[14px] text-chat leading-5 text-text-primary outline-none placeholder:text-text-muted"
              onListLocalSkills={onListLocalSkills}
              onListLocalApps={onListLocalApps}
              models={models}
              selectedModel={selectedModel}
              selectedModelOptions={selectedModelOptions}
              planModeActive={planModeActive}
              onSetPlanMode={onSetPlanMode}
              onSetGoal={onSetGoal}
              onSelectModel={onSelectModel}
              onBlockedModelSelect={onBlockedModelSelect}
              isModelSelectionReady={isModelSelectionReady}
              sendKey={sendKey}
              followUpBehavior={followUpBehavior}
              isStreaming={isStreaming}
            />
            {canExpandInput && (
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="expand-input-button"
                onClick={() => setFullscreenInputOpen(true)}
                className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full text-text-secondary hover:bg-muted"
                aria-label={t('workbench.expand_input', '展开输入框')}
              >
                <Maximize2 className="h-4 w-4" />
              </ControlButton>
            )}
            {showSubmitButton &&
              (showPauseButton && isStreaming && !canSend ? (
                <ControlButton
                  variant="primary"
                  size="sm"
                  type="button"
                  data-testid="pause-response-button"
                  onClick={onPause}
                  className="absolute bottom-1 right-1 flex h-11 w-11 items-center justify-center rounded-[22px] bg-text-primary p-0 text-background hover:bg-text-primary/90"
                  aria-label={t('workbench.pause_response', '暂停回复')}
                >
                  <Square className="h-4 w-4 fill-current" />
                </ControlButton>
              ) : isStreaming && canSend ? (
                <div className="absolute bottom-1 right-1 flex items-center rounded-[22px] bg-text-primary text-background">
                  <ControlButton
                    variant="primary"
                    size="sm"
                    type="submit"
                    data-testid={submitButtonTestId}
                    className="flex h-11 w-11 items-center justify-center rounded-l-[22px] hover:bg-text-primary/90"
                    aria-label={primaryBusyLabel}
                  >
                    <ArrowUp className="h-5 w-5" />
                  </ControlButton>
                  <ActionMenu
                    ariaLabel={t('workbench.choose_send_mode', '选择发送方式')}
                    testId="send-mode-menu-button"
                    icon={ChevronDown}
                    density="dense"
                    triggerClassName="flex items-center justify-center rounded-r-[22px] border-l border-background/20 hover:bg-text-primary/90"
                    items={[
                      {
                        label: t('workbench.send_after_turn', '当前回复结束后发送'),
                        icon: Clock3,
                        testId: 'send-after-turn-option',
                        onSelect: () => onSubmit(composerRef.current?.getValue() ?? value),
                        shortcut: followUpBehavior === 'queue' ? primarySendShortcut : undefined,
                      },
                      {
                        label:
                          modelChangePending && activeModelLabel
                            ? t(
                                'workbench.guide_current_turn_with_model',
                                'Guide current response · {{model}}',
                                { model: activeModelLabel }
                              )
                            : t('workbench.guide_current_turn', '引导当前回复'),
                        icon: CornerDownRight,
                        testId: 'guide-current-turn-option',
                        onSelect: () =>
                          onSubmit(composerRef.current?.getValue() ?? value, {
                            guideWhenBusy: true,
                          }),
                        shortcut: followUpBehavior === 'guide' ? primarySendShortcut : undefined,
                      },
                      {
                        label:
                          modelChangePending && selectedModelLabel
                            ? t(
                                'workbench.interrupt_and_send_with_model',
                                'Interrupt and use {{model}}',
                                { model: selectedModelLabel }
                              )
                            : t('workbench.interrupt_and_send', '打断并立即发送'),
                        icon: Zap,
                        testId: 'interrupt-and-send-option',
                        onSelect: () =>
                          onSubmit(composerRef.current?.getValue() ?? value, {
                            interruptWhenBusy: true,
                          }),
                        shortcut: 'Command+Shift+Enter',
                      },
                    ]}
                  />
                </div>
              ) : (
                <ControlButton
                  variant="primary"
                  size="sm"
                  type="submit"
                  data-testid={submitButtonTestId}
                  disabled={!canSend}
                  className="absolute bottom-1 right-1 flex h-11 w-11 items-center justify-center rounded-[22px] bg-text-primary p-0 text-background disabled:bg-text-muted"
                  aria-label={t('workbench.send_message', '发送消息')}
                >
                  <ArrowUp className="h-5 w-5" />
                </ControlButton>
              ))}
          </div>
        </form>
        {contextSheetOpen && (
          <div
            data-testid="mobile-context-sheet-backdrop"
            className="fixed inset-0 z-modal bg-black/20"
            onClick={() => setContextSheetOpen(false)}
          >
            <div
              data-testid="mobile-context-sheet"
              className="absolute bottom-0 left-0 right-0 rounded-t-[28px] border border-border bg-background px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-3 shadow-[0_-20px_60px_rgba(0,0,0,0.18)] wework:border-white/10"
              onClick={event => event.stopPropagation()}
            >
              <div className="mx-auto mb-4 h-1 w-12 rounded-full bg-border" />
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="mobile-take-photo-button"
                onClick={() => cameraInputRef.current?.click()}
                className="flex h-14 w-full items-center gap-4 rounded-2xl px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
              >
                <Camera className="h-6 w-6 shrink-0 text-text-secondary" />
                <span>{t('workbench.take_photo', '拍照')}</span>
              </ControlButton>
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="mobile-upload-image-button"
                onClick={() => imageInputRef.current?.click()}
                className="flex h-14 w-full items-center gap-4 rounded-2xl px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
              >
                <Image className="h-6 w-6 shrink-0 text-text-secondary" />
                <span>{t('workbench.upload_image', '上传文件')}</span>
              </ControlButton>
              {openDrawing && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="mobile-draw-attachment-button"
                  onClick={() => {
                    setContextSheetOpen(false)
                    openDrawing()
                  }}
                  className="flex h-14 w-full items-center gap-4 rounded-2xl px-4 text-left text-base text-text-primary hover:bg-muted"
                >
                  <PencilLine className="h-6 w-6 shrink-0 text-text-secondary" />
                  <span>{t('workbench.drawing.title')}</span>
                </ControlButton>
              )}
              {onSetPlanMode && !planModeActive && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="mobile-set-plan-mode-button"
                  onClick={handleSetPlanMode}
                  className="flex h-14 w-full items-center gap-4 rounded-2xl px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
                >
                  <ClipboardList className="h-6 w-6 shrink-0 text-text-secondary" />
                  <span>{t('workbench.plan_mode', '计划模式')}</span>
                </ControlButton>
              )}
              {onSetGoal && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="mobile-set-goal-button"
                  onClick={handleSetGoal}
                  className="flex h-14 w-full items-center gap-4 rounded-2xl px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
                >
                  <Target className="h-6 w-6 shrink-0 text-primary" />
                  <span>{t('workbench.pursue_goal', '追求目标')}</span>
                </ControlButton>
              )}
              {selectedPermissionControls ? (
                <div
                  data-testid="mobile-permission-mode-row"
                  className="flex h-14 w-full items-center justify-between gap-4 rounded-2xl px-4 text-text-primary"
                >
                  <span className="flex min-w-0 items-center gap-4 text-base font-semibold">
                    <ShieldCheck className="h-6 w-6 shrink-0 text-text-secondary" />
                    <span>{t('workbench.permission_mode', '权限模式')}</span>
                  </span>
                  <PermissionModeSelector
                    {...selectedPermissionControls}
                    disabled={disabled || selectedPermissionControls.disabled}
                  />
                </div>
              ) : null}
            </div>
          </div>
        )}
        {fullscreenInputOpen && (
          <div
            data-testid="fullscreen-input-sheet"
            className="fixed inset-0 z-modal flex h-dvh flex-col bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
          >
            <div className="mb-2 flex min-w-0 justify-end">
              {renderModelSelector(fullscreenModelSelectorControl)}
            </div>
            <div className="relative min-h-0 flex-1">
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="collapse-input-button"
                onClick={() => setFullscreenInputOpen(false)}
                className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-background/90 text-text-secondary shadow-sm hover:bg-muted"
                aria-label={t('workbench.collapse_input', '折叠输入框')}
              >
                <Minimize2 className="h-5 w-5" />
              </ControlButton>
              <ComposerTextarea
                ref={fullscreenComposerRef}
                onOpenModelSelector={fullscreenModelSelectorControl.requestOpen}
                modelSelectorOpen={fullscreenModelSelectorControl.open}
                testId="fullscreen-message-input"
                textareaRef={fullscreenInputRef}
                value={value}
                onChange={handleComposerChange}
                onBlur={onBlur}
                onCompositionStart={onCompositionStart}
                onCompositionEnd={onCompositionEnd}
                onSubmit={onSubmit}
                canSend={canSend}
                placeholder={placeholder}
                rows={8}
                onPasteFiles={files => onFileSelect?.(files)}
                onOpenSkillFile={onOpenSkillFile}
                workspaceTarget={workspaceTarget}
                workspaceFileApi={workspaceFileApi}
                cloudMentionCandidates={cloudMentionCandidates}
                conversationMentionCandidates={conversationMentionCandidates}
                cloudProjectCandidates={cloudProjectCandidates}
                cloudSpaceEnabled={cloudSpaceEnabled}
                onSelectCloudProject={onSelectCloudProject}
                className="h-full w-full overflow-y-auto rounded-2xl border border-border bg-background px-4 pb-4 pt-14 text-chat text-text-primary outline-none"
                onListLocalSkills={onListLocalSkills}
                onListLocalApps={onListLocalApps}
                models={models}
                selectedModel={selectedModel}
                selectedModelOptions={selectedModelOptions}
                planModeActive={planModeActive}
                onSetPlanMode={onSetPlanMode}
                onSetGoal={onSetGoal}
                onSelectModel={onSelectModel}
                onBlockedModelSelect={onBlockedModelSelect}
                isModelSelectionReady={isModelSelectionReady}
                sendKey={sendKey}
                followUpBehavior={followUpBehavior}
                isStreaming={isStreaming}
              />
            </div>
          </div>
        )}
      </div>
    )
  }
)
