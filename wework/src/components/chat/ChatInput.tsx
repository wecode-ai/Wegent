import { useState } from 'react'
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
  RuntimeWorkListResponse,
  SkillRef,
  UnifiedModel,
  UnifiedSkill,
} from '@/types/api'
import type { GuidanceWorkbenchMessage, QueuedWorkbenchMessage } from '@/types/workbench'
import type { CodeCommentContext, WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import { ConversationQueuePanel } from './ConversationQueuePanel'
import { CompactChatComposer } from './composer/CompactChatComposer'
import { GoalStatusBar } from './composer/GoalStatusBar'
import { ProjectChatComposer } from './composer/ProjectChatComposer'
import { TaskPlanProgress } from './composer/TaskPlanProgress'

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
  selectedSkills: SkillRef[]
  attachments: Attachment[]
  uploadingFiles: Map<string, { file: File; progress: number }>
  errors: Map<string, string>
  contextUsage?: RuntimeContextUsage
  isOptionsLocked: boolean
  modelSelectorOpenSignal?: number
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
  isStreaming?: boolean
  onPause?: () => void
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
      <div className="mb-2 text-sm font-medium leading-5 text-text-muted">
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
            <div className="truncate text-sm font-medium leading-5 text-text-primary">
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
  submitDisabled = false,
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
  isStreaming = false,
  onPause,
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
    onOpenSkillFile,
    workspaceTarget,
    workspaceFileApi,
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
          isModelSelectionReady={controls.isModelSelectionReady ?? true}
          attachments={controls.attachments}
          codeComments={codeComments}
          uploadingFiles={controls.uploadingFiles}
          attachmentErrors={controls.errors}
          contextUsage={controls.contextUsage}
          onSelectModel={controls.setSelectedModel}
          onSelectModelAndOptions={controls.setSelectedModelAndOptions}
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
        {queueResumeDialog}
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
        onSelectModel={controls.setSelectedModel}
        onBlockedModelSelect={controls.onBlockedModelSelect}
        isModelSelectionReady={controls.isModelSelectionReady ?? true}
        isStreaming={isStreaming}
        onPause={onPause}
      />
      {queueResumeDialog}
    </div>
  )
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
