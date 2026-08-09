import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  LoaderCircle,
  PencilLine,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react'
import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { buildRefinedPluginPrompt } from '@/features/plugins/pluginTrial'
import type { PluginTrialRefinementRequest } from '@/features/plugins/usePluginTrialPromptRefinement'
import type { ComposerTextareaHandle } from './composer/ComposerTextarea'

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
  hasConversationContext?: boolean
  onDismissTrialGuide?: () => void
  onApplyTrialTemplate?: (template: PluginPathComponent) => void
  onRefineTrialPrompt?: (request: PluginTrialRefinementRequest) => Promise<string>
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
  onBlur?: () => void
  onCompositionEnd?: () => void
  onSubmit: (
    valueOverride?: string,
    options?: ChatSubmitOptions
  ) => void | boolean | Promise<void | boolean>
  disabled: boolean
  pluginPickerIconOnly?: boolean
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
  externalMentionCandidates?: ComposerExternalMentionCandidate[]
  cloudProjectCandidates?: ComposerCloudMentionCandidate[]
  cloudSpaceEnabled?: boolean
  onSelectExternalMention?: (candidate: ComposerExternalMentionCandidate) => void
  onSelectCloudProject?: (project: CloudProject) => void
  selectedCloudProjectId?: CloudProject['id']
  isStreaming?: boolean
  onPause?: () => void
  showWorkspaceMenu?: boolean
  inputLeadingContext?: ReactNode
  toolbarLeadingContext?: ReactNode
  projectWorkBarTrailingContext?: ReactNode
  modelSelectorOverride?: ReactNode
  onCompactContext?: () => void | Promise<void>
  goal?: RuntimeGoal | null
  goalContinuing?: boolean
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
  draft,
  hasConversationContext = false,
  onApplyTemplate,
  onRefinePrompt,
  onApplyRefinedPrompt,
  onDismiss,
}: {
  templates: PluginPathComponent[]
  pluginName?: string
  draft: string
  hasConversationContext?: boolean
  onApplyTemplate?: (template: PluginPathComponent) => void
  onRefinePrompt?: (draft: string) => Promise<string>
  onApplyRefinedPrompt?: (prompt: string) => void
  onDismiss?: () => void
}) {
  const { t } = useTranslation('common')
  const availableTemplates = templates.filter(template => !template.unavailableReason).slice(0, 6)
  const [recommendedTemplatePath, setRecommendedTemplatePath] = useState(
    availableTemplates[0]?.path ?? ''
  )
  const [showOtherTasks, setShowOtherTasks] = useState(false)
  const [refinedPrompt, setRefinedPrompt] = useState('')
  const [refining, setRefining] = useState(false)
  const [refineError, setRefineError] = useState('')
  const recommendedTemplate =
    availableTemplates.find(template => template.path === recommendedTemplatePath) ??
    availableTemplates[0] ??
    null
  const otherTemplates = availableTemplates.filter(
    template => !recommendedTemplate || template.path !== recommendedTemplate.path
  )
  const recommendationTitle = refinedPrompt
    ? refinedPrompt
    : recommendedTemplate
      ? pluginTemplateDisplayTitle(recommendedTemplate, t)
      : t('workbench.plugin_trial_ai_empty_recommendation', '让 AI 推荐一个适合当前目标的任务')
  const recommendationDescription = refinedPrompt
    ? t('workbench.plugin_trial_ai_recommendation_hint', '已结合当前输入、插件能力和近期对话整理')
    : recommendedTemplate
      ? pluginTemplateDisplayDescription(recommendedTemplate, t) ||
        t('workbench.plugin_trial_recommendation_source_hint', '来自插件提供的常用任务')
      : t('workbench.plugin_trial_ai_action_draft_hint', '根据当前输入和插件能力整理')

  if (!pluginName && availableTemplates.length === 0) return null
  if (availableTemplates.length === 0 && !onRefinePrompt) return null

  const refine = async () => {
    if (!onRefinePrompt || refining) return
    setRefining(true)
    setRefineError('')
    try {
      setRefinedPrompt(await onRefinePrompt(draft))
      setShowOtherTasks(false)
    } catch (error) {
      setRefineError(
        error instanceof Error
          ? error.message
          : t('workbench.plugin_trial_ai_error', 'AI 暂时无法完善任务，请重试')
      )
    } finally {
      setRefining(false)
    }
  }

  const applyRecommendation = () => {
    if (refinedPrompt) {
      onApplyRefinedPrompt?.(refinedPrompt)
      return
    }
    if (recommendedTemplate) {
      onApplyTemplate?.(recommendedTemplate)
      return
    }
    void refine()
  }

  return (
    <section
      className="mx-auto mb-2 max-w-[760px] overflow-hidden rounded-xl border border-border/25 bg-background shadow-md"
      data-testid="plugin-trial-template-strip"
      aria-label={t('workbench.plugin_trial_recommendation_title', '插件使用建议')}
    >
      <div className="flex items-start justify-between gap-3 px-3 py-2.5">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium leading-5 text-text-primary">
              {pluginName
                ? `${pluginName} ${t('workbench.plugin_trial_recommendation_label', '使用建议')}`
                : t('workbench.plugin_trial_recommendation_title', '插件使用建议')}
            </h3>
            <p className="mt-0.5 truncate text-xs leading-4 text-text-muted">
              {refinedPrompt
                ? t(
                    'workbench.plugin_trial_ai_recommended_start',
                    'AI 已根据当前输入推荐一个任务起点'
                  )
                : hasConversationContext
                  ? t(
                      'workbench.plugin_trial_recommendation_context_hint',
                      '先确认推荐任务，AI 也可以参考近期对话换一个'
                    )
                  : t(
                      'workbench.plugin_trial_recommendation_start_hint',
                      '先确认一个任务起点，再带入输入框'
                    )}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
      <div className="space-y-2 px-2 pb-2">
        <div
          className="flex min-h-[72px] flex-col gap-2 rounded-lg border border-border/20 bg-surface/45 px-2.5 py-2.5 sm:flex-row sm:items-center"
          data-testid={refinedPrompt ? 'plugin-trial-ai-result' : 'plugin-trial-recommendation'}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/20 bg-background text-text-secondary">
            <PencilLine className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <strong
              className="line-clamp-2 text-sm font-medium leading-5 text-text-primary"
              data-testid="plugin-trial-recommendation-title"
            >
              {recommendationTitle}
            </strong>
            <span className="mt-0.5 block truncate text-xs leading-4 text-text-muted">
              {recommendationDescription}
            </span>
          </span>
          <button
            type="button"
            data-testid="plugin-trial-recommendation-apply"
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-text-primary px-3 text-xs font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={applyRecommendation}
            disabled={refining || (!refinedPrompt && !recommendedTemplate && !onRefinePrompt)}
          >
            {recommendedTemplate || refinedPrompt
              ? t('workbench.plugin_trial_use_recommendation', '使用这个任务')
              : t('workbench.plugin_trial_generate_recommendation', '生成建议')}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        {refineError && (
          <div
            className="flex items-center justify-between gap-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs leading-4 text-red-700"
            role="alert"
            data-testid="plugin-trial-ai-error"
          >
            <span>{refineError}</span>
            <button
              type="button"
              className="shrink-0 font-medium hover:underline"
              onClick={() => void refine()}
            >
              {t('workbench.retry', '重试')}
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1 px-0.5 text-xs leading-4 text-text-muted">
          {onRefinePrompt && (
            <button
              type="button"
              data-testid="plugin-trial-ai-refine"
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void refine()}
              disabled={refining}
            >
              {refining ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {refining
                ? t('workbench.plugin_trial_ai_refining', 'AI 正在推荐…')
                : t('workbench.plugin_trial_ai_another_recommendation', 'AI 换一个建议')}
            </button>
          )}
          {onRefinePrompt && otherTemplates.length > 0 && (
            <span className="h-4 w-px bg-border/40" aria-hidden="true" />
          )}
          {otherTemplates.length > 0 && (
            <button
              type="button"
              data-testid="plugin-trial-other-tasks-toggle"
              aria-expanded={showOtherTasks}
              className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
              onClick={() => setShowOtherTasks(current => !current)}
            >
              {t('workbench.plugin_trial_view_other_tasks', '查看其他常用任务')}
              {showOtherTasks ? (
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          )}
        </div>
        {showOtherTasks && otherTemplates.length > 0 && (
          <div
            className="overflow-hidden rounded-lg border border-border/20"
            data-testid="plugin-trial-other-tasks"
          >
            {otherTemplates.map(template => {
              const displayTitle = pluginTemplateDisplayTitle(template, t)
              const descriptionPreview = pluginTemplateDisplayDescription(template, t)
              return (
                <button
                  key={template.path}
                  type="button"
                  className="flex min-h-10 w-full items-center gap-2 border-b border-border/15 px-2.5 py-1.5 text-left transition-colors last:border-b-0 hover:bg-surface"
                  data-testid="plugin-trial-template-card"
                  onClick={() => {
                    setRecommendedTemplatePath(template.path)
                    setRefinedPrompt('')
                    setRefineError('')
                    setShowOtherTasks(false)
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-xs font-medium leading-4 text-text-primary">
                      {displayTitle}
                    </strong>
                    {descriptionPreview && (
                      <span className="block truncate text-xs leading-4 text-text-muted">
                        {descriptionPreview}
                      </span>
                    )}
                  </span>
                  <CornerDownLeft
                    className="h-3.5 w-3.5 shrink-0 text-text-muted"
                    aria-hidden="true"
                  />
                </button>
              )
            })}
          </div>
        )}
      </div>
      <p className="border-t border-border/20 px-3 py-2 text-xs leading-4 text-text-muted">
        {t('workbench.plugin_trial_recommendation_footer', '使用后仍可继续修改，不会自动发送')}
      </p>
    </section>
  )
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    value,
    onChange,
    onBlur,
    onCompositionEnd,
    onSubmit,
    disabled,
    pluginPickerIconOnly = false,
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
    externalMentionCandidates,
    cloudProjectCandidates,
    cloudSpaceEnabled,
    onSelectExternalMention,
    onSelectCloudProject,
    selectedCloudProjectId,
    isStreaming = false,
    onPause,
    showWorkspaceMenu,
    inputLeadingContext,
    toolbarLeadingContext,
    projectWorkBarTrailingContext,
    modelSelectorOverride,
    onCompactContext,
    goal,
    goalContinuing = false,
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
  const [pendingQueuedSend, setPendingQueuedSend] = useState<PendingQueuedSend | null>(null)
  const [pendingModelSelection, setPendingModelSelection] = useState<PendingModelSelection | null>(
    null
  )

  const composerRef = useRef<ComposerTextareaHandle>(null)

  useImperativeHandle(
    ref,
    () => ({
      getValue: () => composerRef.current?.getValue() ?? value,
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
    onBlur,
    onCompositionEnd,
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
    externalMentionCandidates,
    conversationMentionCandidates,
    cloudProjectCandidates,
    cloudSpaceEnabled,
    onSelectExternalMention,
    onSelectCloudProject,
    selectedCloudProjectId,
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
          draft={value}
          hasConversationContext={controls.hasConversationContext}
          onApplyTemplate={controls.onApplyTrialTemplate ?? controls.applyTrialTemplate}
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
            onEditGoal={onEditGoal}
            onPauseGoal={onPauseGoal}
            onResumeGoal={onResumeGoal}
            onClearGoal={onClearGoal}
          />
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
          onFileSelect={files => {
            void controls.handleFileSelect(files)
          }}
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
          showProjectWorkBar={showProjectWorkBar}
          projectWorkBarTrailingContext={projectWorkBarTrailingContext}
          modelSelectorOverride={modelSelectorOverride}
          onListLocalSkills={controls.listLocalSkills}
          onListLocalApps={controls.listLocalApps}
          isStreaming={isStreaming}
          onPause={onPause}
          showWorkspaceMenu={showWorkspaceMenu}
          inputLeadingContext={inputLeadingContext}
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
        draft={value}
        hasConversationContext={controls.hasConversationContext}
        onApplyTemplate={controls.onApplyTrialTemplate ?? controls.applyTrialTemplate}
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
