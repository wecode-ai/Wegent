import { PluginTrialTemplateStrip } from '@wegent/collaboration/composer/PluginTrialTemplateStrip'
import { PluginTrialSelectionContext } from '@wegent/collaboration/composer/PluginTrialSelectionContext'
import { ComposerErrorBanner } from '@wegent/collaboration/composer'
import {
  forwardRef,
  useContext,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { visibleRuntimeGoal } from '@/lib/runtime-goal'
import type {
  Attachment,
  DeviceInfo,
  LocalDeviceApp,
  LocalDeviceSkill,
  ModelOptions,
  PluginPathComponent,
  ProjectExecutionMode,
  ProjectWithTasks,
  RuntimeContextUsage,
  RuntimeGoal,
  RuntimeGoalExecutionStatus,
  RuntimePlanEventPayload,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  SkillRef,
  UnifiedModel,
  UnifiedSkill,
} from '@/types/api'
import type { GuidanceWorkbenchMessage, QueuedWorkbenchMessage } from '@/types/workbench'
import type { ProjectWorktreeAvailability } from '@/lib/worktree-availability'
import type { CodeCommentContext, WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import type { CloudProject } from '@/api/deliveries'
import type { ComposerCloudMentionCandidate } from './composer/composerMentionCandidates'
import type { ComposerExternalMentionCandidate } from './composer/composerTextareaTypes'
import {
  buildConversationMentionCandidates,
  type ConversationMentionCandidate,
} from '@/lib/conversation-mentions'
import { ConversationQueuePanel } from './ConversationQueuePanel'
import { CompactChatComposer } from './composer/CompactChatComposer'
import { GoalStatusBar } from './composer/GoalStatusBar'
import { ProjectChatComposer } from './composer/ProjectChatComposer'
import { TaskPlanProgress } from './composer/TaskPlanProgress'
import { buildRefinedPluginPrompt, buildTrialTemplatePrompt } from '@/features/plugins/pluginTrial'
import type { PluginTrialRefinementRequest } from '@/features/plugins/usePluginTrialPromptRefinement'
import type { ComposerTextareaHandle } from './composer/ComposerTextarea'
import { ComposerPluginIcon } from './composer/ComposerPluginIcon'
import type { ModelSelectorCloseReason } from '@wegent/collaboration/controls/model-selector-types'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import type { QuickPhrase } from '@/desktop/appPreferences'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'

export type ProjectCreateMode = 'scratch' | 'existing' | 'git'

export type ChatInputHandle = ComposerTextareaHandle

export interface ProjectChatControls {
  scopeKey?: string
  models: UnifiedModel[]
  skills: UnifiedSkill[]
  selectedModel: UnifiedModel | null
  activeModel?: UnifiedModel | null
  selectedModelOptions: ModelOptions
  isModelSelectionReady?: boolean
  trialTemplates?: PluginPathComponent[]
  trialPluginName?: string
  trialPluginApp?: LocalDeviceApp
  hasConversationContext?: boolean
  showTrialGuide?: (title: string, app: LocalDeviceApp) => void
  onDismissTrialGuide?: () => void
  onRefineTrialPrompt?: (request: PluginTrialRefinementRequest) => Promise<string>
  dismissTrialGuide?: () => void
  selectedSkills: SkillRef[]
  attachments: Attachment[]
  uploadingFiles: Map<string, { file: File; progress: number }>
  errors: Map<string, string>
  contextUsage?: RuntimeContextUsage
  isOptionsLocked: boolean
  modelSelectorOpenSignal?: number
  onModelSelectorOpenChange?: (open: boolean, closeReason?: ModelSelectorCloseReason) => void
  setSelectedModel: (model: UnifiedModel | null) => void
  setSelectedModelAndOptions?: (model: UnifiedModel, options: ModelOptions) => void
  setSelectedModelOption: (optionId: string, value: string) => void
  getSelectedModel?: () => UnifiedModel | null
  getSelectedModelOptions?: () => ModelOptions
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  toggleSkill: (skill: SkillRef) => void
  handleFileSelect: (files: File | File[]) => Promise<void>
  removeAttachment: (attachmentId: number) => Promise<void>
  listLocalSkills: () => Promise<LocalDeviceSkill[]>
  listLocalApps?: () => Promise<LocalDeviceApp[]>
}

export interface ProjectWorkControls {
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  runtimeWork?: RuntimeWorkListResponse | null
  currentProject?: ProjectWithTasks | null
  currentProjectId?: number
  currentStandaloneDeviceId?: string | null
  currentRuntimeDeviceId?: string | null
  currentRuntimeTask?: RuntimeTaskAddress | null
  selectedDeviceWorkspaceId?: number | null
  pendingProjectWorkspaceProjectId?: number | null
  executionMode: ProjectExecutionMode
  executionModeLocked?: boolean
  worktreeAvailability?: ProjectWorktreeAvailability
  onSelectProject: (projectId: number | null) => void
  onSelectStandaloneDevice: (deviceId: string | null) => void
  onSelectProjectWorkspace?: (projectId: number, deviceWorkspaceId: number | null) => void
  onBindProjectWorkspace?: (projectId: number) => void
  onExecutionModeChange: (mode: ProjectExecutionMode) => void
  onCreateProjectMode?: (mode: ProjectCreateMode) => void
  branchName?: string
  branchLoading?: boolean
  onRefreshBranch?: () => Promise<void>
  onListBranches?: () => Promise<string[]>
  onCheckoutBranch?: (branchName: string) => Promise<void>
  onCreateBranch?: (branchName: string) => Promise<void>
  onGenerateBranchName?: (sourceText: string) => Promise<string>
  branchNameSource?: string
  worktreeBranch?: string | null
  onWorktreeBranchChange?: (branchName: string | null) => void
  // When false, the project trigger renders a static folder icon instead of the
  // hover-to-clear button (for defaults that cannot be cleared from the bar).
  showProjectClearButton?: boolean
  projectMenuOpenSignal?: number
  projectMenuAnchorElement?: HTMLElement | null
}

export interface ChatInputProps {
  presentation?: 'chat' | 'document'
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  onCompositionStart?: () => void
  onCompositionEnd?: () => void
  onSubmit: (
    valueOverride?: string,
    options?: ChatSubmitOptions
  ) => void | boolean | Promise<void | boolean>
  disabled: boolean
  pluginPickerIconOnly?: boolean
  submitDisabled?: boolean
  requireText?: boolean
  error?: string | null
  disabledReason?: string
  placeholder?: string
  inputTestId?: string
  nativeEmptyCaret?: boolean
  submitButtonTestId?: string
  submitLabel?: string
  variant?: 'compact' | 'desktop'
  collapseWhenIdle?: boolean
  projectPhrases?: QuickPhrase[]
  projectChat?: ProjectChatControls
  projectWork?: ProjectWorkControls
  showProjectWorkBar?: boolean
  projectWorkBar?: ReactNode
  showExecutionTools?: boolean
  queuedMessages?: QueuedWorkbenchMessage[]
  guidanceMessages?: GuidanceWorkbenchMessage[]
  codeComments?: CodeCommentContext[]
  onCancelQueuedMessage?: (id: string) => void
  onForceStartQueuedMessage?: (id: string) => void
  onSendQueuedAsGuidance?: (id: string) => void
  onInterruptAndSendQueuedMessage?: (id: string) => void
  onEditQueuedMessage?: (id: string) => void
  onReorderQueuedMessages?: (sourceId: string, targetId: string) => void
  queuePaused?: boolean
  onResumeQueue?: () => void
  onResumeQueueWithInput?: (
    valueOverride?: string,
    options?: ChatSubmitOptions
  ) => void | Promise<void>
  onClearQueue?: () => void
  onCancelGuidanceMessage?: (id: string) => void
  onClearCodeComments?: () => void
  onOpenSkillFile?: (path: string) => void
  workspaceTarget?: WorkspaceTarget | null
  workspaceFileApi?: WorkspaceFileApi
  cloudMentionCandidates?: ComposerCloudMentionCandidate[]
  externalMentionCandidates?: ComposerExternalMentionCandidate[]
  mentionScope?: 'all' | 'external'
  cloudProjectCandidates?: ComposerCloudMentionCandidate[]
  cloudSpaceEnabled?: boolean
  onSelectExternalMention?: (candidate: ComposerExternalMentionCandidate) => void
  onSelectCloudProject?: (project: CloudProject) => void
  isStreaming?: boolean
  onPause?: () => void
  showWorkspaceMenu?: boolean
  contextHeader?: ReactNode
  inputLeadingContext?: ReactNode
  onDismissInputLeadingContext?: () => void
  toolbarLeadingContext?: ReactNode
  projectWorkBarMiddleContext?: ReactNode
  projectWorkBarTrailingContext?: ReactNode
  projectWorkBarEndContext?: ReactNode
  modelSelectorOverride?: ReactNode
  onCompactContext?: () => void | Promise<void>
  goal?: RuntimeGoal | null
  goalContinuing?: boolean
  goalExecutionStatus?: RuntimeGoalExecutionStatus | null
  taskPlan?: RuntimePlanEventPayload | null
  goalDraftActive?: boolean
  onSetGoal?: () => void
  onConfigureSupervisor?: () => void
  supervisorEnabled?: boolean
  supervisorPending?: boolean
  onCancelGoalDraft?: () => void
  onEditGoal?: () => void
  onPauseGoal?: () => void
  onResumeGoal?: () => void
  onClearGoal?: () => void
}

export interface ChatSubmitOptions {
  guideWhenBusy?: boolean
  interruptWhenBusy?: boolean
}

interface PendingQueuedSend {
  valueOverride?: string
  options?: ChatSubmitOptions
}

interface PendingModelSelection {
  model: UnifiedModel | null
  options?: ModelOptions
}

function isSameModel(left: UnifiedModel | null | undefined, right: UnifiedModel | null): boolean {
  return left?.name === right?.name && left?.type === right?.type
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    value,
    presentation,
    onChange,
    onBlur,
    onCompositionStart,
    onCompositionEnd,
    onSubmit,
    disabled,
    pluginPickerIconOnly = false,
    submitDisabled = false,
    requireText = false,
    error,
    disabledReason,
    placeholder,
    inputTestId,
    nativeEmptyCaret = false,
    submitButtonTestId,
    submitLabel,
    variant = 'compact',
    collapseWhenIdle = false,
    projectPhrases,
    projectChat,
    projectWork,
    showProjectWorkBar = true,
    showExecutionTools = true,
    queuedMessages = [],
    guidanceMessages = [],
    codeComments = [],
    onCancelQueuedMessage,
    onForceStartQueuedMessage,
    onSendQueuedAsGuidance,
    onInterruptAndSendQueuedMessage,
    onEditQueuedMessage,
    onReorderQueuedMessages,
    queuePaused,
    onResumeQueue,
    onResumeQueueWithInput,
    onClearQueue,
    onCancelGuidanceMessage,
    onClearCodeComments,
    onOpenSkillFile,
    workspaceTarget,
    workspaceFileApi,
    cloudMentionCandidates,
    externalMentionCandidates,
    mentionScope,
    cloudProjectCandidates,
    cloudSpaceEnabled,
    onSelectExternalMention,
    onSelectCloudProject,
    isStreaming = false,
    onPause,
    showWorkspaceMenu,
    contextHeader,
    inputLeadingContext,
    onDismissInputLeadingContext,
    toolbarLeadingContext,
    projectWorkBarMiddleContext,
    projectWorkBar,
    projectWorkBarTrailingContext,
    projectWorkBarEndContext,
    modelSelectorOverride,
    onCompactContext,
    goal,
    goalContinuing = false,
    goalExecutionStatus = null,
    taskPlan,
    goalDraftActive = false,
    onSetGoal,
    onConfigureSupervisor,
    supervisorEnabled = false,
    supervisorPending = false,
    onCancelGoalDraft,
    onEditGoal,
    onPauseGoal,
    onResumeGoal,
    onClearGoal,
  },
  ref
) {
  const { t } = useTranslation('common')
  const { t: tChat } = useTranslation('chat')
  const workbench = useContext(WorkbenchContext)
  const sendKey = workbench?.state?.user?.preferences?.send_key ?? 'enter'
  const followUpBehavior = workbench?.state?.user?.preferences?.follow_up_behavior ?? 'queue'
  const [pendingQueuedSend, setPendingQueuedSend] = useState<PendingQueuedSend | null>(null)
  const [pendingModelSelection, setPendingModelSelection] = useState<PendingModelSelection | null>(
    null
  )

  const composerRef = useRef<ComposerTextareaHandle>(null)

  useImperativeHandle(
    ref,
    () => ({
      get element() {
        return composerRef.current?.element ?? null
      },
      focus: () => composerRef.current?.focus(),
      getValue: () => composerRef.current?.getValue() ?? value,
      insertReference: reference => composerRef.current?.insertReference(reference),
      setValue: (nextValue, selectionOffset) =>
        composerRef.current?.setValue(nextValue, selectionOffset),
    }),
    [value]
  )

  // Apply through the live composer handle so BufferedChatInput's debounced parent
  // onChange path cannot leave ProseMirror on the pre-apply draft for ~300ms.
  const applyRefinedPrompt = (prompt: string) => {
    const next = buildRefinedPluginPrompt(composerRef.current?.getValue() ?? value, prompt)
    composerRef.current?.setValue(next)
    onChange(next)
  }

  const handleEditQueuedMessage = (id: string) => {
    onEditQueuedMessage?.(id)
    composerRef.current?.focus()
  }

  const displayedGoal = visibleRuntimeGoal(goal)
  const inputPlaceholder = goalDraftActive
    ? t('workbench.goal_input_placeholder', 'WeWork 应该往哪个方向努力?')
    : (placeholder ?? t('workbench.input_placeholder', '随心输入'))
  const controls: ProjectChatControls = projectChat ?? {
    models: [],
    skills: [],
    selectedModel: null,
    selectedModelOptions: {},
    isModelSelectionReady: true,
    trialTemplates: [],
    trialPluginName: '',
    selectedSkills: [],
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
    contextUsage: undefined,
    isOptionsLocked: false,
    modelSelectorOpenSignal: undefined,
    setSelectedModel: () => {},
    setSelectedModelOption: () => {},
    onBlockedModelSelect: () => {},
    toggleSkill: () => {},
    handleFileSelect: async () => {},
    removeAttachment: async () => {},
    listLocalSkills: async () => [],
    listLocalApps: async () => [],
  }
  const currentRuntimeProject = projectWork?.runtimeWork?.projects.find(
    item => runtimeProjectUiId(item.project) === projectWork.currentProject?.id
  )?.project
  const projectQuickPhrases =
    projectPhrases ??
    (currentRuntimeProject?.source === 'local_project'
      ? (currentRuntimeProject.aiSettings?.quickPhrases ?? [])
      : [])
  const applyTrialTemplate = (template: PluginPathComponent) => {
    const editor = composerRef.current
    if (!editor) return
    const next = buildTrialTemplatePrompt(editor.getValue(), template, controls.trialPluginName)
    editor.setValue(next)
    onChange(next)
    editor.focus()
  }
  const conversationMentionCandidates = useMemo(
    () =>
      buildConversationMentionCandidates(
        projectWork?.runtimeWork,
        projectWork?.currentRuntimeTask
      ).map(candidate => conversationMentionCandidate(candidate, t)),
    [projectWork?.currentRuntimeTask, projectWork?.runtimeWork, t]
  )

  const planModeActive = controls.selectedModelOptions.collaborationMode === 'plan'
  const handleSetPlanMode = () => {
    if (goalDraftActive) {
      onCancelGoalDraft?.()
    }
    controls.setSelectedModelOption('collaborationMode', 'plan')
  }
  const handleClearPlanMode = () => {
    controls.setSelectedModelOption('collaborationMode', 'default')
  }
  const handleCompactContext = () => {
    if (onCompactContext) {
      void onCompactContext()
      return
    }
    void onSubmit('/compact')
  }

  const applyModelSelection = (model: UnifiedModel | null, options?: ModelOptions) => {
    if (options && model && controls.setSelectedModelAndOptions) {
      controls.setSelectedModelAndOptions(model, options)
      return
    }
    controls.setSelectedModel(model)
  }

  const requestModelSelection = (model: UnifiedModel | null, options?: ModelOptions) => {
    const selectionChangesModel = !isSameModel(controls.selectedModel, model)
    if (
      selectionChangesModel &&
      controls.activeModel &&
      !isSameModel(controls.activeModel, model)
    ) {
      setPendingModelSelection({ model, options })
      return false
    }
    applyModelSelection(model, options)
    return true
  }

  const confirmModelSelection = () => {
    if (!pendingModelSelection) return
    const { model, options } = pendingModelSelection
    setPendingModelSelection(null)
    applyModelSelection(model, options)
  }
  const cancelModelSelection = () => {
    setPendingModelSelection(null)
    controls.onModelSelectorOpenChange?.(false, 'dismiss')
  }

  const handleSubmit = (valueOverride?: string, options?: ChatSubmitOptions) => {
    const submittedValue = (valueOverride ?? value).trim()
    if (queuePaused && queuedMessages.length > 0 && submittedValue) {
      setPendingQueuedSend({ valueOverride, options })
      return
    }
    if (options === undefined) {
      void onSubmit(valueOverride)
      return
    }
    void onSubmit(valueOverride, options)
  }

  const sendWithQueue = (clearQueue: boolean) => {
    if (!pendingQueuedSend) return
    const { valueOverride, options } = pendingQueuedSend
    setPendingQueuedSend(null)
    if (clearQueue) {
      onClearQueue?.()
      void onSubmit(valueOverride, options)
      return
    }
    if (onResumeQueueWithInput) {
      composerRef.current?.setValue('', 0)
      onChange('')
      void onResumeQueueWithInput(valueOverride, options)
      return
    }
    void Promise.resolve(onSubmit(valueOverride, options)).finally(() => onResumeQueue?.())
  }

  const composerProps = {
    presentation,
    value,
    onChange,
    onBlur,
    onCompositionStart,
    onCompositionEnd,
    onSubmit: handleSubmit,
    disabled,
    submitDisabled,
    requireText,
    disabledReason,
    placeholder: disabledReason ? '' : inputPlaceholder,
    inputTestId,
    nativeEmptyCaret,
    submitButtonTestId,
    submitLabel,
    onOpenSkillFile,
    workspaceTarget,
    workspaceFileApi,
    cloudMentionCandidates,
    externalMentionCandidates,
    mentionScope,
    conversationMentionCandidates,
    cloudProjectCandidates,
    cloudSpaceEnabled,
    onSelectExternalMention,
    onSelectCloudProject,
    sendKey,
    followUpBehavior,
    isStreaming,
  }
  const errorBanner = <ComposerErrorBanner error={error} />
  const queuePanel = (
    <ConversationQueuePanel
      queuedMessages={queuedMessages}
      guidanceMessages={guidanceMessages}
      onCancelQueuedMessage={onCancelQueuedMessage}
      onForceStartQueuedMessage={onForceStartQueuedMessage}
      onSendQueuedAsGuidance={onSendQueuedAsGuidance}
      onInterruptAndSendQueuedMessage={onInterruptAndSendQueuedMessage}
      onEditQueuedMessage={onEditQueuedMessage ? handleEditQueuedMessage : undefined}
      onReorderQueuedMessages={onReorderQueuedMessages}
      queuePaused={queuePaused}
      onResumeQueue={onResumeQueue}
      onCancelGuidanceMessage={onCancelGuidanceMessage}
    />
  )
  const queueResumeDialog = pendingQueuedSend ? (
    <QueueResumeDialog
      t={tChat}
      onCancel={() => setPendingQueuedSend(null)}
      onPreserve={() => sendWithQueue(false)}
      onClear={() => sendWithQueue(true)}
    />
  ) : null
  const modelSwitchWarningDialog = pendingModelSelection ? (
    <ModelSwitchWarningDialog
      t={t}
      targetModelLabel={
        pendingModelSelection.model?.displayName ||
        pendingModelSelection.model?.name ||
        t('workbench.model_auto_select', 'Auto select')
      }
      onCancel={cancelModelSelection}
      onConfirm={confirmModelSelection}
    />
  ) : null

  if (variant === 'desktop') {
    return (
      <PluginTrialSelectionContext.Provider value={controls.showTrialGuide}>
        <div className="w-full">
          <TaskPlanProgress plan={taskPlan} />
          {queuePanel}
          {errorBanner}
          <PluginTrialTemplateStrip
            translate={(key, fallback, options) => t(key, fallback ?? key, options)}
            renderPluginIcon={(app, props) => <ComposerPluginIcon app={app} {...props} />}
            key={controls.trialPluginName || 'plugin-trial'}
            templates={controls.trialTemplates ?? []}
            pluginName={controls.trialPluginName}
            pluginApp={controls.trialPluginApp}
            draft={value}
            hasConversationContext={controls.hasConversationContext}
            onApplyTemplate={applyTrialTemplate}
            onRefinePrompt={
              controls.onRefineTrialPrompt
                ? draft =>
                    controls.onRefineTrialPrompt?.({
                      pluginName: controls.trialPluginName ?? '',
                      draft,
                      templates: controls.trialTemplates ?? [],
                    }) ?? Promise.reject(new Error('AI refinement unavailable'))
                : undefined
            }
            onApplyRefinedPrompt={applyRefinedPrompt}
            onDismiss={controls.onDismissTrialGuide ?? controls.dismissTrialGuide}
          />
          {(contextHeader || (displayedGoal && !goalDraftActive)) && (
            <div
              data-testid="composer-context-rail"
              className={[
                'mb-2 min-w-0 items-center divide-x divide-border/70 overflow-hidden rounded-xl border border-border/60 bg-muted/45 px-1 [&>*]:min-w-0 [&>*]:overflow-hidden',
                contextHeader && displayedGoal && !goalDraftActive
                  ? 'grid grid-cols-[minmax(0,1fr)_minmax(13rem,32%)]'
                  : 'flex',
              ].join(' ')}
            >
              {displayedGoal && !goalDraftActive && (
                <GoalStatusBar
                  integrated
                  goal={displayedGoal}
                  continuing={goalContinuing}
                  executionStatus={goalExecutionStatus}
                  onEditGoal={onEditGoal}
                  onPauseGoal={onPauseGoal}
                  onResumeGoal={onResumeGoal}
                  onClearGoal={onClearGoal}
                />
              )}
              {contextHeader}
            </div>
          )}
          <ProjectChatComposer
            ref={composerRef}
            {...composerProps}
            pluginPickerIconOnly={pluginPickerIconOnly}
            models={controls.models}
            selectedModel={controls.selectedModel}
            activeModel={controls.activeModel}
            selectedModelOptions={controls.selectedModelOptions}
            modelSelectorOpenSignal={controls.modelSelectorOpenSignal}
            onModelSelectorOpenChange={controls.onModelSelectorOpenChange}
            isModelSelectionReady={controls.isModelSelectionReady ?? true}
            attachments={controls.attachments}
            codeComments={codeComments}
            uploadingFiles={controls.uploadingFiles}
            attachmentErrors={controls.errors}
            contextUsage={controls.contextUsage}
            onSelectModel={model => requestModelSelection(model)}
            onSelectModelAndOptions={(model, options) => requestModelSelection(model, options)}
            onSelectModelOption={controls.setSelectedModelOption}
            onBlockedModelSelect={controls.onBlockedModelSelect}
            onFileSelect={files => controls.handleFileSelect(files)}
            planModeActive={planModeActive}
            onSetPlanMode={handleSetPlanMode}
            onClearPlanMode={handleClearPlanMode}
            onSetGoal={onSetGoal}
            onConfigureSupervisor={onConfigureSupervisor}
            supervisorEnabled={supervisorEnabled}
            supervisorPending={supervisorPending}
            onCompactContext={handleCompactContext}
            goalDraftActive={goalDraftActive}
            onCancelGoalDraft={onCancelGoalDraft}
            onRemoveAttachment={attachmentId => {
              void controls.removeAttachment(attachmentId)
            }}
            onClearCodeComments={onClearCodeComments}
            projectWork={
              projectWork ?? {
                projects: [],
                devices: [],
                runtimeWork: null,
                currentProject: null,
                currentProjectId: undefined,
                currentStandaloneDeviceId: null,
                selectedDeviceWorkspaceId: null,
                pendingProjectWorkspaceProjectId: null,
                executionMode: 'current_workspace',
                executionModeLocked: false,
                onSelectProject: () => {},
                onSelectStandaloneDevice: () => {},
                onSelectProjectWorkspace: () => {},
                onBindProjectWorkspace: () => {},
                onExecutionModeChange: () => {},
                onCreateProjectMode: undefined,
              }
            }
            projectPhrases={projectQuickPhrases}
            showProjectWorkBar={showProjectWorkBar}
            showExecutionTools={showExecutionTools}
            projectWorkBarMiddleContext={projectWorkBarMiddleContext}
            projectWorkBar={projectWorkBar}
            projectWorkBarTrailingContext={projectWorkBarTrailingContext}
            projectWorkBarEndContext={projectWorkBarEndContext}
            modelSelectorOverride={modelSelectorOverride}
            onListLocalSkills={controls.listLocalSkills}
            onListLocalApps={controls.listLocalApps}
            isStreaming={isStreaming}
            onPause={onPause}
            showWorkspaceMenu={showWorkspaceMenu}
            collapseWhenIdle={collapseWhenIdle}
            inputLeadingContext={inputLeadingContext}
            onDismissInputLeadingContext={onDismissInputLeadingContext}
            toolbarLeadingContext={toolbarLeadingContext}
          />
          {queueResumeDialog}
          {modelSwitchWarningDialog}
        </div>
      </PluginTrialSelectionContext.Provider>
    )
  }

  return (
    <PluginTrialSelectionContext.Provider value={controls.showTrialGuide}>
      <div className="w-full">
        <TaskPlanProgress plan={taskPlan} />
        {queuePanel}
        {errorBanner}
        <PluginTrialTemplateStrip
          translate={(key, fallback, options) => t(key, fallback ?? key, options)}
          renderPluginIcon={(app, props) => <ComposerPluginIcon app={app} {...props} />}
          key={controls.trialPluginName || 'plugin-trial'}
          templates={controls.trialTemplates ?? []}
          pluginName={controls.trialPluginName}
          pluginApp={controls.trialPluginApp}
          draft={value}
          hasConversationContext={controls.hasConversationContext}
          onApplyTemplate={applyTrialTemplate}
          onRefinePrompt={
            controls.onRefineTrialPrompt
              ? draft =>
                  controls.onRefineTrialPrompt?.({
                    pluginName: controls.trialPluginName ?? '',
                    draft,
                    templates: controls.trialTemplates ?? [],
                  }) ?? Promise.reject(new Error('AI refinement unavailable'))
              : undefined
          }
          onApplyRefinedPrompt={applyRefinedPrompt}
          onDismiss={controls.onDismissTrialGuide ?? controls.dismissTrialGuide}
        />
        {displayedGoal && !goalDraftActive && (
          <GoalStatusBar
            goal={displayedGoal}
            continuing={goalContinuing}
            executionStatus={goalExecutionStatus}
            onEditGoal={onEditGoal}
            onPauseGoal={onPauseGoal}
            onResumeGoal={onResumeGoal}
            onClearGoal={onClearGoal}
          />
        )}
        <CompactChatComposer
          ref={composerRef}
          {...composerProps}
          attachments={controls.attachments}
          codeComments={codeComments}
          uploadingFiles={controls.uploadingFiles}
          attachmentErrors={controls.errors}
          onFileSelect={files => controls.handleFileSelect(files)}
          planModeActive={planModeActive}
          onSetPlanMode={handleSetPlanMode}
          onClearPlanMode={handleClearPlanMode}
          onSetGoal={onSetGoal}
          goalDraftActive={goalDraftActive}
          onCancelGoalDraft={onCancelGoalDraft}
          onRemoveAttachment={attachmentId => {
            void controls.removeAttachment(attachmentId)
          }}
          onClearCodeComments={onClearCodeComments}
          onListLocalSkills={controls.listLocalSkills}
          onListLocalApps={controls.listLocalApps}
          models={controls.models}
          selectedModel={controls.selectedModel}
          activeModel={controls.activeModel}
          selectedModelOptions={controls.selectedModelOptions}
          onSelectModel={model => requestModelSelection(model)}
          onSelectModelOption={controls.setSelectedModelOption}
          onBlockedModelSelect={controls.onBlockedModelSelect}
          isModelSelectionReady={controls.isModelSelectionReady ?? true}
          isStreaming={isStreaming}
          onPause={onPause}
          projectPhrases={projectQuickPhrases}
        />
        {queueResumeDialog}
        {modelSwitchWarningDialog}
      </div>
    </PluginTrialSelectionContext.Provider>
  )
})

function conversationMentionCandidate(
  candidate: ConversationMentionCandidate,
  t: ReturnType<typeof useTranslation>['t']
) {
  const workspaceLabel =
    candidate.projectName || candidate.address.workspacePath || candidate.address.deviceId
  return {
    kind: 'conversation' as const,
    key: candidate.key,
    title: candidate.title,
    description: workspaceLabel,
    metaLabel: t('workbench.mention_conversation', 'Conversation'),
    testId: candidate.testId,
    enabled: true,
    reference: candidate.reference,
    searchAliases: [
      candidate.title,
      candidate.projectName ?? '',
      candidate.address.workspacePath ?? '',
    ],
    conversation: candidate,
  }
}

function QueueResumeDialog({
  t,
  onCancel,
  onPreserve,
  onClear,
}: {
  t: (key: string) => string
  onCancel: () => void
  onPreserve: () => void
  onClear: () => void
}) {
  return createPortal(
    <div
      data-testid="paused-queue-send-dialog-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="paused-queue-send-dialog-title"
        data-testid="paused-queue-send-dialog"
        className="w-full max-w-[360px] rounded-lg border border-border bg-popover p-4 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
      >
        <h2
          id="paused-queue-send-dialog-title"
          className="text-base font-semibold text-text-primary"
        >
          {t('queue.send_with_paused_title')}
        </h2>
        <p className="mt-1.5 text-sm leading-5 text-text-secondary">
          {t('queue.send_with_paused_description')}
        </p>
        <div className="mt-4 flex justify-end gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="paused-queue-send-cancel-button"
            onClick={onCancel}
            className="h-8 rounded-md border-border bg-base px-3 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            {t('queue.send_with_paused_cancel')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="paused-queue-send-clear-button"
            onClick={onClear}
            className="h-8 rounded-md border-red-200 bg-base px-3 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
          >
            {t('queue.send_with_paused_clear')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="paused-queue-send-preserve-button"
            onClick={onPreserve}
            className="h-8 rounded-md border-text-primary bg-text-primary px-3 text-xs text-background hover:bg-text-primary/90 hover:text-background"
          >
            {t('queue.send_with_paused_preserve')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function ModelSwitchWarningDialog({
  t,
  targetModelLabel,
  onCancel,
  onConfirm,
}: {
  t: ReturnType<typeof useTranslation>['t']
  targetModelLabel: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return createPortal(
    <div
      data-testid="model-switch-warning-dialog-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-switch-warning-dialog-title"
        aria-describedby="model-switch-warning-dialog-description"
        data-testid="model-switch-warning-dialog"
        className="w-full max-w-[400px] rounded-2xl border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.24)]"
      >
        <h2 id="model-switch-warning-dialog-title" className="heading-small text-text-primary">
          {t('workbench.model_switch_warning_title', 'Switch model?')}
        </h2>
        <p
          id="model-switch-warning-dialog-description"
          className="mt-2 text-sm leading-5 text-text-secondary"
        >
          {t(
            'workbench.model_switch_warning_description',
            'Switching to {{model}} may change how the existing context is understood. Tool support, response style, and task continuity may also differ.',
            { model: targetModelLabel }
          )}
        </p>
        <p className="mt-2 text-sm leading-5 text-text-secondary">
          {t(
            'workbench.model_switch_warning_effect',
            'The new model will be used for the next message. If a response is in progress, it will continue with the current model.'
          )}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="model-switch-warning-cancel-button"
            onClick={onCancel}
            className="h-8 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            {t('workbench.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="model-switch-warning-confirm-button"
            onClick={onConfirm}
            className="h-8 rounded-lg bg-text-primary px-4 text-sm text-background hover:bg-text-primary/90"
          >
            {t('workbench.model_switch_warning_confirm', 'Switch model')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
