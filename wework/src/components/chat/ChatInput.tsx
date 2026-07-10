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
  RuntimeWorkListResponse,
  SkillRef,
  UnifiedModel,
  UnifiedSkill,
} from '@/types/api'
import type { GuidanceWorkbenchMessage, QueuedWorkbenchMessage } from '@/types/workbench'
import type { CodeCommentContext } from '@/types/workspace-files'
import { ConversationQueuePanel } from './ConversationQueuePanel'
import { CompactChatComposer } from './composer/CompactChatComposer'
import { GoalStatusBar } from './composer/GoalStatusBar'
import { ProjectChatComposer } from './composer/ProjectChatComposer'
import { TaskPlanProgress } from './composer/TaskPlanProgress'

export type ProjectCreateMode = 'scratch' | 'existing' | 'git'

export interface ProjectChatControls {
  models: UnifiedModel[]
  skills: UnifiedSkill[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  isModelSelectionReady?: boolean
  trialTemplates?: PluginPathComponent[]
  selectedSkills: SkillRef[]
  attachments: Attachment[]
  uploadingFiles: Map<string, { file: File; progress: number }>
  errors: Map<string, string>
  contextUsage?: RuntimeContextUsage
  isOptionsLocked: boolean
  modelSelectorOpenSignal?: number
  setSelectedModel: (model: UnifiedModel | null) => void
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
  selectedDeviceWorkspaceId?: number | null
  pendingProjectWorkspaceProjectId?: number | null
  executionMode: ProjectExecutionMode
  executionModeLocked?: boolean
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
}

export interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (valueOverride?: string, options?: ChatSubmitOptions) => void | Promise<void>
  disabled: boolean
  error?: string | null
  disabledReason?: string
  placeholder?: string
  variant?: 'compact' | 'desktop'
  projectChat?: ProjectChatControls
  projectWork?: ProjectWorkControls
  showProjectWorkBar?: boolean
  queuedMessages?: QueuedWorkbenchMessage[]
  guidanceMessages?: GuidanceWorkbenchMessage[]
  codeComments?: CodeCommentContext[]
  onCancelQueuedMessage?: (id: string) => void
  onSendQueuedAsGuidance?: (id: string) => void
  onEditQueuedMessage?: (id: string) => void
  onCancelGuidanceMessage?: (id: string) => void
  onClearCodeComments?: () => void
  isStreaming?: boolean
  onPause?: () => void
  onCompactContext?: () => void | Promise<void>
  goal?: RuntimeGoal | null
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
}

function PluginTrialTemplateStrip({ templates }: { templates: PluginPathComponent[] }) {
  const { t } = useTranslation('common')
  const visibleTemplates = templates.filter(template => !template.unavailableReason).slice(0, 8)
  if (visibleTemplates.length === 0) return null

  return (
    <section
      className="mb-2 rounded-2xl border border-border/70 bg-background px-3 py-3 shadow-[0_10px_32px_rgba(0,0,0,0.06)]"
      data-testid="plugin-trial-template-strip"
      aria-label={t('workbench.plugin_trial_templates', '模板')}
    >
      <div className="mb-2 text-[13px] font-medium leading-5 text-text-muted">
        {t('workbench.plugin_trial_templates', '模板')}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {visibleTemplates.map(template => (
          <div
            key={template.path}
            className="w-[132px] shrink-0 rounded-xl border border-border/70 bg-surface/50 p-3"
            data-testid="plugin-trial-template-card"
          >
            <div className="mb-3 flex h-[72px] items-center justify-center rounded-lg border border-border/60 bg-background">
              {template.logoUrl || template.logoUrlDark ? (
                <img
                  src={template.logoUrl || template.logoUrlDark || ''}
                  alt=""
                  className="h-9 w-9 object-contain"
                />
              ) : (
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-sm font-medium text-text-secondary">
                  {template.name.slice(0, 1).toUpperCase()}
                </span>
              )}
            </div>
            <div className="truncate text-[13px] font-medium leading-5 text-text-primary">
              {template.name}
            </div>
            {template.description ? (
              <div className="mt-0.5 line-clamp-2 text-xs leading-4 text-text-muted">
                {template.description}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled,
  error,
  disabledReason,
  placeholder,
  variant = 'compact',
  projectChat,
  projectWork,
  showProjectWorkBar = true,
  queuedMessages = [],
  guidanceMessages = [],
  codeComments = [],
  onCancelQueuedMessage,
  onSendQueuedAsGuidance,
  onEditQueuedMessage,
  onCancelGuidanceMessage,
  onClearCodeComments,
  isStreaming = false,
  onPause,
  onCompactContext,
  goal,
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

  const composerProps = {
    value,
    onChange,
    onSubmit,
    disabled,
    disabledReason,
    placeholder: disabledReason ? '' : inputPlaceholder,
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
      onEditQueuedMessage={onEditQueuedMessage}
      onCancelGuidanceMessage={onCancelGuidanceMessage}
    />
  )

  if (variant === 'desktop') {
    return (
      <div className="w-full">
        <TaskPlanProgress plan={taskPlan} />
        {queuePanel}
        {errorBanner}
        <PluginTrialTemplateStrip templates={controls.trialTemplates ?? []} />
        {displayedGoal && !goalDraftActive && (
          <GoalStatusBar
            goal={displayedGoal}
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
          selectedModelOptions={controls.selectedModelOptions}
          modelSelectorOpenSignal={controls.modelSelectorOpenSignal}
          isModelSelectionReady={controls.isModelSelectionReady ?? true}
          attachments={controls.attachments}
          codeComments={codeComments}
          uploadingFiles={controls.uploadingFiles}
          attachmentErrors={controls.errors}
          contextUsage={controls.contextUsage}
          onSelectModel={controls.setSelectedModel}
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
        />
      </div>
    )
  }

  return (
    <div className="w-full">
      <TaskPlanProgress plan={taskPlan} />
      {queuePanel}
      {errorBanner}
      <PluginTrialTemplateStrip templates={controls.trialTemplates ?? []} />
      {displayedGoal && !goalDraftActive && (
        <GoalStatusBar
          goal={displayedGoal}
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
        selectedModelOptions={controls.selectedModelOptions}
        onSelectModel={controls.setSelectedModel}
        onBlockedModelSelect={controls.onBlockedModelSelect}
        isModelSelectionReady={controls.isModelSelectionReady ?? true}
        isStreaming={isStreaming}
        onPause={onPause}
      />
    </div>
  )
}
