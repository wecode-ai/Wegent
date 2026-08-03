import { Boxes, Check, ChevronLeft, ChevronRight, CornerDownLeft, Sparkles, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
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
  RuntimePlanEventPayload,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  SkillRef,
  UnifiedModel,
  UnifiedSkill,
} from '@/types/api'
import type { GuidanceWorkbenchMessage, QueuedWorkbenchMessage } from '@/types/workbench'
import type { CodeCommentContext, WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import type { CloudProject } from '@/api/deliveries'
import type { ComposerCloudMentionCandidate } from './composer/composerMentionCandidates'
import {
  buildConversationMentionCandidates,
  type ConversationMentionCandidate,
} from '@/lib/conversation-mentions'
import { ConversationQueuePanel } from './ConversationQueuePanel'
import { CompactChatComposer } from './composer/CompactChatComposer'
import { GoalStatusBar } from './composer/GoalStatusBar'
import { ProjectChatComposer } from './composer/ProjectChatComposer'
import { TaskPlanProgress } from './composer/TaskPlanProgress'
import { buildContextualPluginPrompt } from '@/features/plugins/pluginTrial'

export type ProjectCreateMode = 'scratch' | 'existing' | 'git'

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
  hasConversationContext?: boolean
  onDismissTrialGuide?: () => void
  onApplyTrialTemplate?: (template: PluginPathComponent) => void
  dismissTrialGuide?: () => void
  applyTrialTemplate?: (template: PluginPathComponent) => void
  selectedSkills: SkillRef[]
  attachments: Attachment[]
  uploadingFiles: Map<string, { file: File; progress: number }>
  errors: Map<string, string>
  contextUsage?: RuntimeContextUsage
  isOptionsLocked: boolean
  modelSelectorOpenSignal?: number
  onModelSelectorOpenChange?: (open: boolean) => void
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
  isGitProject?: boolean
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
  worktreeBranch?: string | null
  onWorktreeBranchChange?: (branchName: string | null) => void
  projectMenuOpenSignal?: number
  projectMenuAnchorElement?: HTMLElement | null
}

export interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (valueOverride?: string, options?: ChatSubmitOptions) => void | Promise<void>
  disabled: boolean
  submitDisabled?: boolean
  error?: string | null
  disabledReason?: string
  placeholder?: string
  inputTestId?: string
  submitButtonTestId?: string
  variant?: 'compact' | 'desktop'
  projectChat?: ProjectChatControls
  projectWork?: ProjectWorkControls
  showProjectWorkBar?: boolean
  queuedMessages?: QueuedWorkbenchMessage[]
  guidanceMessages?: GuidanceWorkbenchMessage[]
  codeComments?: CodeCommentContext[]
  onCancelQueuedMessage?: (id: string) => void
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
  cloudProjectCandidates?: ComposerCloudMentionCandidate[]
  cloudSpaceEnabled?: boolean
  onSelectCloudProject?: (project: CloudProject) => void
  isStreaming?: boolean
  onPause?: () => void
  showWorkspaceMenu?: boolean
  toolbarLeadingContext?: ReactNode
  onCompactContext?: () => void | Promise<void>
  goal?: RuntimeGoal | null
  goalContinuing?: boolean
  taskPlan?: RuntimePlanEventPayload | null
  goalDraftActive?: boolean
  onSetGoal?: () => void
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

function pluginTemplateDisplayTitle(template: PluginPathComponent, t: TFunction<'common'>): string {
  const source = `${template.name} ${template.description ?? ''}`.toLowerCase()
  if (/working[- ]tree|current workspace|当前工作区|当前改动/.test(source)) {
    return t('workbench.plugin_trial_review_current_changes', '当前改动')
  }
  if (/merge base|compare.*branch|分支.*对比|合并基线/.test(source)) {
    return t('workbench.plugin_trial_review_branch', '分支对比')
  }
  if (/this commit|single commit|单次提交|这次提交/.test(source)) {
    return t('workbench.plugin_trial_review_commit', '单次提交')
  }
  return template.name
}

function pluginTemplateDisplayDescription(
  template: PluginPathComponent,
  t: TFunction<'common'>
): string {
  const source = `${template.name} ${template.description ?? ''}`.toLowerCase()
  const providedDescription = template.description
    ?.split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && line !== template.name.trim())
  if (providedDescription) return providedDescription
  if (/working[- ]tree|current workspace|当前工作区|当前改动/.test(source)) {
    return t('workbench.plugin_trial_review_current_changes_hint', '检查未提交代码')
  }
  if (/merge base|compare.*branch|分支.*对比|合并基线/.test(source)) {
    return t('workbench.plugin_trial_review_branch_hint', '与合并基线比较')
  }
  if (/this commit|single commit|单次提交|这次提交/.test(source)) {
    return t('workbench.plugin_trial_review_commit_hint', '定位高风险问题')
  }
  return ''
}

function isSameModel(left: UnifiedModel | null | undefined, right: UnifiedModel | null): boolean {
  return left?.name === right?.name && left?.type === right?.type
}

function PluginTrialTemplateStrip({
  templates,
  pluginName,
  hasConversationContext = false,
  onApplyTemplate,
  onApplyContext,
  onDismiss,
}: {
  templates: PluginPathComponent[]
  pluginName?: string
  hasConversationContext?: boolean
  onApplyTemplate?: (template: PluginPathComponent) => void
  onApplyContext?: () => void
  onDismiss?: () => void
}) {
  const { t } = useTranslation('common')
  const availableTemplates = templates.filter(template => !template.unavailableReason).slice(0, 6)
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(availableTemplates.length / 3))
  const visiblePage = Math.min(page, pageCount - 1)
  const visibleTemplates = availableTemplates.slice(visiblePage * 3, visiblePage * 3 + 3)
  const [selectedTemplatePath, setSelectedTemplatePath] = useState(
    availableTemplates[0]?.path ?? ''
  )
  const [contextSuggestionApplied, setContextSuggestionApplied] = useState(false)

  if (availableTemplates.length === 0) return null

  return (
    <section
      className="mx-auto mb-2 max-w-[760px] overflow-hidden rounded-xl border border-border/25 bg-background shadow-md"
      data-testid="plugin-trial-template-strip"
      aria-label={t('workbench.plugin_trial_guide_title', '插件使用建议')}
    >
      <div className="flex items-start justify-between gap-3 px-3 pb-2 pt-2.5">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium leading-5 text-text-primary">
              {t('workbench.plugin_trial_guide_title', '插件使用建议')}
            </div>
            <p className="truncate text-xs leading-4 text-text-muted">
              {pluginName
                ? t('workbench.plugin_trial_guide_plugin_hint', {
                    plugin: pluginName,
                    defaultValue: `正在使用 ${pluginName} · 选择后仍可修改`,
                  })
                : t('workbench.plugin_trial_guide_hint_short', '选择后仍可修改，不会自动发送')}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {pageCount > 1 && (
            <>
              <button
                type="button"
                data-testid="plugin-trial-template-previous"
                aria-label={t('workbench.plugin_trial_previous_scenarios', '上一组场景')}
                disabled={visiblePage === 0}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-text-primary disabled:opacity-35"
                onClick={() => setPage(current => Math.max(0, current - 1))}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                data-testid="plugin-trial-template-next"
                aria-label={t('workbench.plugin_trial_next_scenarios', '下一组场景')}
                disabled={visiblePage >= pageCount - 1}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-text-primary disabled:opacity-35"
                onClick={() => setPage(current => Math.min(pageCount - 1, current + 1))}
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </>
          )}
          {onDismiss && (
            <button
              type="button"
              data-testid="plugin-trial-template-dismiss"
              aria-label={t('workbench.close', '关闭')}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-text-primary"
              onClick={onDismiss}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div className="px-1.5 pb-1.5">
        {hasConversationContext && onApplyContext && (
          <>
            <button
              type="button"
              data-testid="plugin-trial-context-suggestion"
              aria-pressed={contextSuggestionApplied}
              className={[
                'flex min-h-12 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20',
                contextSuggestionApplied ? 'bg-surface text-text-primary' : 'hover:bg-surface/70',
              ].join(' ')}
              onClick={() => {
                setContextSuggestionApplied(true)
                setSelectedTemplatePath('')
                onApplyContext()
              }}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                <Sparkles className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm font-medium leading-5 text-text-primary">
                  {t('workbench.plugin_trial_context_action', '让 AI 结合当前对话完善')}
                </strong>
                <span className="block truncate text-xs leading-4 text-text-muted">
                  {t(
                    'workbench.plugin_trial_context_action_hint',
                    '带入聊天后，AI 会参考近期消息和已有材料补全任务'
                  )}
                </span>
              </span>
              {contextSuggestionApplied ? (
                <Check className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
              ) : (
                <CornerDownLeft className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
              )}
            </button>
            <p className="px-2 pb-1 pt-2 text-xs leading-4 text-text-muted">
              {t('workbench.plugin_trial_or_choose_example', '或者从插件示例开始')}
            </p>
          </>
        )}
        {visibleTemplates.map(template => {
          const selected = selectedTemplatePath === template.path
          const displayTitle = pluginTemplateDisplayTitle(template, t)
          const descriptionPreview = pluginTemplateDisplayDescription(template, t)
          const showDescription = Boolean(descriptionPreview)
          return (
            <button
              key={template.path}
              type="button"
              className={[
                'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20',
                selected ? 'bg-surface text-text-primary' : 'hover:bg-surface/70',
              ].join(' ')}
              data-testid="plugin-trial-template-card"
              aria-pressed={selected}
              onClick={() => {
                setContextSuggestionApplied(false)
                setSelectedTemplatePath(template.path)
                onApplyTemplate?.(template)
              }}
            >
              {template.logoUrl || template.logoUrlDark ? (
                <img
                  src={template.logoUrl || template.logoUrlDark || ''}
                  alt=""
                  className="h-6 w-6 shrink-0 rounded-md object-contain"
                />
              ) : (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-background text-text-muted">
                  <Boxes className="h-4 w-4" aria-hidden="true" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm font-medium leading-5 text-text-primary">
                  {displayTitle}
                </strong>
                {showDescription && (
                  <span className="block truncate text-xs leading-4 text-text-muted">
                    {descriptionPreview}
                  </span>
                )}
              </span>
              <CornerDownLeft className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
            </button>
          )
        })}
      </div>
      <p className="border-t border-border/20 px-3 py-2 text-xs leading-4 text-text-muted">
        {t(
          'workbench.plugin_trial_guide_hint',
          '以上内容只会带入输入框，你可以继续修改，不会自动发送'
        )}
      </p>
    </section>
  )
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled,
  submitDisabled = false,
  error,
  disabledReason,
  placeholder,
  inputTestId,
  submitButtonTestId,
  variant = 'compact',
  projectChat,
  projectWork,
  showProjectWorkBar = true,
  queuedMessages = [],
  guidanceMessages = [],
  codeComments = [],
  onCancelQueuedMessage,
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
  cloudProjectCandidates,
  cloudSpaceEnabled,
  onSelectCloudProject,
  isStreaming = false,
  onPause,
  showWorkspaceMenu,
  toolbarLeadingContext,
  onCompactContext,
  goal,
  goalContinuing = false,
  taskPlan,
  goalDraftActive = false,
  onSetGoal,
  onCancelGoalDraft,
  onEditGoal,
  onPauseGoal,
  onResumeGoal,
  onClearGoal,
}: ChatInputProps) {
  const { t } = useTranslation('common')
  const { t: tChat } = useTranslation('chat')
  const [pendingQueuedSend, setPendingQueuedSend] = useState<PendingQueuedSend | null>(null)
  const [pendingModelSelection, setPendingModelSelection] = useState<PendingModelSelection | null>(
    null
  )
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
      return
    }
    applyModelSelection(model, options)
  }

  const confirmModelSelection = () => {
    if (!pendingModelSelection) return
    const { model, options } = pendingModelSelection
    setPendingModelSelection(null)
    applyModelSelection(model, options)
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
      onChange('')
      void onResumeQueueWithInput(valueOverride, options)
      return
    }
    void Promise.resolve(onSubmit(valueOverride, options)).finally(() => onResumeQueue?.())
  }

  const composerProps = {
    value,
    onChange,
    onSubmit: handleSubmit,
    disabled,
    submitDisabled,
    disabledReason,
    placeholder: disabledReason ? '' : inputPlaceholder,
    inputTestId,
    submitButtonTestId,
    onOpenSkillFile,
    workspaceTarget,
    workspaceFileApi,
    cloudMentionCandidates,
    conversationMentionCandidates,
    cloudProjectCandidates,
    cloudSpaceEnabled,
    onSelectCloudProject,
  }
  const errorBanner = error ? (
    <div
      className="mb-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
      data-testid="chat-input-error"
      role="alert"
    >
      {error}
    </div>
  ) : null
  const queuePanel = (
    <ConversationQueuePanel
      queuedMessages={queuedMessages}
      guidanceMessages={guidanceMessages}
      onCancelQueuedMessage={onCancelQueuedMessage}
      onSendQueuedAsGuidance={onSendQueuedAsGuidance}
      onInterruptAndSendQueuedMessage={onInterruptAndSendQueuedMessage}
      onEditQueuedMessage={onEditQueuedMessage}
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
      onCancel={() => setPendingModelSelection(null)}
      onConfirm={confirmModelSelection}
    />
  ) : null

  if (variant === 'desktop') {
    return (
      <div className="w-full">
        <TaskPlanProgress plan={taskPlan} />
        {queuePanel}
        {errorBanner}
        <PluginTrialTemplateStrip
          key={controls.trialPluginName || 'plugin-trial'}
          templates={controls.trialTemplates ?? []}
          pluginName={controls.trialPluginName}
          hasConversationContext={controls.hasConversationContext}
          onApplyTemplate={controls.onApplyTrialTemplate ?? controls.applyTrialTemplate}
          onApplyContext={() =>
            onChange(
              buildContextualPluginPrompt(
                value,
                t(
                  'workbench.plugin_trial_context_prompt',
                  '请结合当前对话最近内容，理解我正在推进的目标，并使用这个插件完成最合适的下一步。信息不足时，只询问一个必要问题。'
                ),
                t('workbench.plugin_trial_current_idea', '我的当前想法')
              )
            )
          }
          onDismiss={controls.onDismissTrialGuide ?? controls.dismissTrialGuide}
        />
        {displayedGoal && !goalDraftActive && (
          <GoalStatusBar
            goal={displayedGoal}
            continuing={goalContinuing}
            onEditGoal={onEditGoal}
            onPauseGoal={onPauseGoal}
            onResumeGoal={onResumeGoal}
            onClearGoal={onClearGoal}
          />
        )}
        <ProjectChatComposer
          {...composerProps}
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
          onFileSelect={files => {
            void controls.handleFileSelect(files)
          }}
          planModeActive={planModeActive}
          onSetPlanMode={handleSetPlanMode}
          onClearPlanMode={handleClearPlanMode}
          onSetGoal={onSetGoal}
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
          showProjectWorkBar={showProjectWorkBar}
          onListLocalSkills={controls.listLocalSkills}
          onListLocalApps={controls.listLocalApps}
          isStreaming={isStreaming}
          onPause={onPause}
          showWorkspaceMenu={showWorkspaceMenu}
          toolbarLeadingContext={toolbarLeadingContext}
        />
        {queueResumeDialog}
        {modelSwitchWarningDialog}
      </div>
    )
  }

  return (
    <div className="w-full">
      <TaskPlanProgress plan={taskPlan} />
      {queuePanel}
      {errorBanner}
      <PluginTrialTemplateStrip
        key={controls.trialPluginName || 'plugin-trial'}
        templates={controls.trialTemplates ?? []}
        pluginName={controls.trialPluginName}
        hasConversationContext={controls.hasConversationContext}
        onApplyTemplate={controls.onApplyTrialTemplate ?? controls.applyTrialTemplate}
        onApplyContext={() =>
          onChange(
            buildContextualPluginPrompt(
              value,
              t(
                'workbench.plugin_trial_context_prompt',
                '请结合当前对话最近内容，理解我正在推进的目标，并使用这个插件完成最合适的下一步。信息不足时，只询问一个必要问题。'
              ),
              t('workbench.plugin_trial_current_idea', '我的当前想法')
            )
          )
        }
        onDismiss={controls.onDismissTrialGuide ?? controls.dismissTrialGuide}
      />
      {displayedGoal && !goalDraftActive && (
        <GoalStatusBar
          goal={displayedGoal}
          continuing={goalContinuing}
          onEditGoal={onEditGoal}
          onPauseGoal={onPauseGoal}
          onResumeGoal={onResumeGoal}
          onClearGoal={onClearGoal}
        />
      )}
      <CompactChatComposer
        {...composerProps}
        attachments={controls.attachments}
        codeComments={codeComments}
        uploadingFiles={controls.uploadingFiles}
        attachmentErrors={controls.errors}
        onFileSelect={files => {
          void controls.handleFileSelect(files)
        }}
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
        onBlockedModelSelect={controls.onBlockedModelSelect}
        isModelSelectionReady={controls.isModelSelectionReady ?? true}
        isStreaming={isStreaming}
        onPause={onPause}
      />
      {queueResumeDialog}
      {modelSwitchWarningDialog}
    </div>
  )
}

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
  return (
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
    </div>
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
  return (
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
    </div>
  )
}
