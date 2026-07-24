import type {
  Attachment,
  LocalDeviceApp,
  LocalDeviceSkill,
  ModelOptions,
  RuntimeContextUsage,
  UnifiedModel,
} from '@/types/api'
import type { CodeCommentContext, WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import { useState, type DragEventHandler, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { ProjectWorkControls } from '../ChatInput'
import { AttachmentBadges } from './AttachmentBadges'
import { ComposerToolbar } from './ComposerToolbar'
import { ComposerTextarea, type ComposerSubmitOptions } from './ComposerTextarea'
import { ProjectWorkBar } from './ProjectWorkBar'
import { useAutoResizeTextarea } from './useAutoResizeTextarea'
import { debugComposerEvent, textMetrics } from './composerDebug'
import type { QuickPhrase } from '@/tauri/appPreferences'
import { readDroppedFiles } from '@/tauri/droppedFiles'
import type { ComposerCloudMentionCandidate } from './composerMentionCandidates'

interface ProjectChatComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (submittedValue?: string, options?: ComposerSubmitOptions) => void
  disabled: boolean
  submitDisabled?: boolean
  disabledReason?: string
  placeholder: string
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  activeModel?: UnifiedModel | null
  selectedModelOptions: ModelOptions
  modelSelectorOpenSignal?: number
  isModelSelectionReady: boolean
  attachments: Attachment[]
  codeComments?: CodeCommentContext[]
  uploadingFiles: Map<string, { file: File; progress: number }>
  attachmentErrors: Map<string, string>
  contextUsage?: RuntimeContextUsage
  onSelectModel: (model: UnifiedModel | null) => void
  onSelectModelAndOptions?: (model: UnifiedModel, options: ModelOptions) => void
  onSelectModelOption: (optionId: string, value: string) => void
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  onFileSelect: (files: File | File[]) => void
  onOpenSkillFile?: (path: string) => void
  workspaceTarget?: WorkspaceTarget | null
  workspaceFileApi?: WorkspaceFileApi
  cloudMentionCandidates?: ComposerCloudMentionCandidate[]
  planModeActive?: boolean
  onSetPlanMode?: () => void
  onClearPlanMode?: () => void
  onSetGoal?: () => void
  onCompactContext?: () => void
  goalDraftActive?: boolean
  onCancelGoalDraft?: () => void
  onRemoveAttachment: (attachmentId: number) => void
  onClearCodeComments?: () => void
  onListLocalSkills?: () => Promise<LocalDeviceSkill[]>
  onListLocalApps?: () => Promise<LocalDeviceApp[]>
  projectWork: ProjectWorkControls
  showProjectWorkBar?: boolean
  isStreaming?: boolean
  onPause?: () => void
  toolbarLeadingContext?: ReactNode
}

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

export function ProjectChatComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  submitDisabled = false,
  disabledReason,
  placeholder,
  models,
  selectedModel,
  activeModel,
  selectedModelOptions,
  modelSelectorOpenSignal,
  isModelSelectionReady,
  attachments,
  codeComments = [],
  uploadingFiles,
  attachmentErrors,
  contextUsage,
  onSelectModel,
  onSelectModelAndOptions,
  onSelectModelOption,
  onBlockedModelSelect,
  onFileSelect,
  onOpenSkillFile,
  workspaceTarget,
  workspaceFileApi,
  cloudMentionCandidates,
  planModeActive = false,
  onSetPlanMode,
  onClearPlanMode,
  onSetGoal,
  onCompactContext,
  goalDraftActive = false,
  onCancelGoalDraft,
  onRemoveAttachment,
  onClearCodeComments,
  onListLocalSkills,
  onListLocalApps,
  projectWork,
  showProjectWorkBar = true,
  isStreaming = false,
  onPause,
  toolbarLeadingContext,
}: ProjectChatComposerProps) {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const textareaRef = useAutoResizeTextarea(value, 168)
  const canSend =
    (value.trim().length > 0 || attachments.length > 0 || codeComments.length > 0) &&
    !disabled &&
    !submitDisabled
  const handleDragOver: DragEventHandler<HTMLFormElement> = event => {
    if (!hasDraggedFiles(event.dataTransfer)) return

    event.preventDefault()
    event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
    setIsDraggingFiles(!disabled)
  }
  const handleDrop: DragEventHandler<HTMLFormElement> = event => {
    if (!hasDraggedFiles(event.dataTransfer)) return

    event.preventDefault()
    setIsDraggingFiles(false)
    if (disabled) return

    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) onFileSelect(files)
  }
  const handleShowTextAttachment = (attachment: Attachment) => {
    const text = attachment.text_content
    if (!text) return

    onChange(value ? `${value}\n${text}` : text)
    onRemoveAttachment(attachment.id)
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }
  const handleQuickPhraseSelect = (phrase: QuickPhrase) => {
    onClearPlanMode?.()
    onCancelGoalDraft?.()
    if (phrase.mode === 'plan') onSetPlanMode?.()
    if (phrase.mode === 'goal') onSetGoal?.()
    onChange(value ? `${value}\n${phrase.content}` : phrase.content)
    if (phrase.attachmentPaths?.length) {
      void readDroppedFiles(phrase.attachmentPaths).then(onFileSelect)
    }
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  return (
    <div
      data-testid="project-chat-composer"
      className="relative w-full rounded-[26px] bg-surface shadow-[0_0_0_0.5px_rgba(13,13,13,0.12),0_3px_7.5px_rgba(0,0,0,0.04),0_0_20px_rgba(0,0,0,0.05)]"
    >
      {showProjectWorkBar && (
        <ProjectWorkBar
          projects={projectWork.projects}
          devices={projectWork.devices}
          runtimeWork={projectWork.runtimeWork}
          currentProject={projectWork.currentProject}
          currentProjectId={projectWork.currentProjectId}
          currentStandaloneDeviceId={projectWork.currentStandaloneDeviceId}
          selectedDeviceWorkspaceId={projectWork.selectedDeviceWorkspaceId}
          pendingProjectWorkspaceProjectId={projectWork.pendingProjectWorkspaceProjectId}
          executionMode={projectWork.executionMode}
          executionModeLocked={projectWork.executionModeLocked}
          isGitProject={projectWork.isGitProject}
          onSelectProject={projectWork.onSelectProject}
          onSelectStandaloneDevice={projectWork.onSelectStandaloneDevice}
          onSelectProjectWorkspace={projectWork.onSelectProjectWorkspace}
          onBindProjectWorkspace={projectWork.onBindProjectWorkspace}
          onExecutionModeChange={projectWork.onExecutionModeChange}
          onCreateProjectMode={projectWork.onCreateProjectMode}
          branchName={projectWork.branchName}
          branchLoading={projectWork.branchLoading}
          onRefreshBranch={projectWork.onRefreshBranch}
          onListBranches={projectWork.onListBranches}
          onCheckoutBranch={projectWork.onCheckoutBranch}
          onCreateBranch={projectWork.onCreateBranch}
          worktreeBranch={projectWork.worktreeBranch}
          onWorktreeBranchChange={projectWork.onWorktreeBranchChange}
          projectMenuOpenSignal={projectWork.projectMenuOpenSignal}
          projectMenuAnchorElement={projectWork.projectMenuAnchorElement}
          className="min-h-10 rounded-t-[26px] bg-surface px-4"
          buttonClassName="text-sm leading-[18px] text-text-secondary hover:bg-background/70 hover:text-text-primary"
        />
      )}
      <form
        data-testid="project-chat-composer-form"
        className={cn(
          'relative z-10 flex min-h-[76px] w-full flex-col rounded-[26px] border bg-background px-4 pb-1.5 pt-2 transition-colors',
          isDraggingFiles ? 'border-focus ring-2 ring-focus/20' : 'border-border/45'
        )}
        onDragEnter={handleDragOver}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setIsDraggingFiles(false)
          }
        }}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onSubmit={event => {
          event.preventDefault()
          debugComposerEvent('project-form-submit', {
            canSend,
            propValue: textMetrics(value),
            submittedValue: textMetrics(value),
            attachmentsCount: attachments.length,
            codeCommentsCount: codeComments.length,
            disabled,
            isStreaming,
          })
          if (canSend) onSubmit(value)
        }}
      >
        <AttachmentBadges
          attachments={attachments}
          uploadingFiles={uploadingFiles}
          errors={attachmentErrors}
          codeComments={codeComments}
          onRemoveAttachment={onRemoveAttachment}
          onShowTextAttachment={handleShowTextAttachment}
          onClearCodeComments={onClearCodeComments}
        />
        {disabledReason && (
          <div
            data-testid="composer-disabled-reason"
            className="mb-2 rounded-xl bg-muted px-3 py-2 text-xs text-text-secondary"
          >
            {disabledReason}
          </div>
        )}
        <ComposerTextarea
          textareaRef={textareaRef}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          canSend={canSend}
          disabled={disabled}
          placeholder={placeholder}
          rows={2}
          onPasteFiles={onFileSelect}
          onOpenSkillFile={onOpenSkillFile}
          workspaceTarget={workspaceTarget}
          workspaceFileApi={workspaceFileApi}
          cloudMentionCandidates={cloudMentionCandidates}
          className="max-h-[112px] min-h-[48px] w-full resize-none overflow-y-auto bg-transparent px-0 pb-0 pt-1 text-chat text-text-secondary outline-none placeholder:text-text-muted/55"
          skillMenuClassName="left-[-1rem] right-[-0.5rem]"
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
        />
        <ComposerToolbar
          canSend={canSend}
          disabled={disabled}
          models={models}
          selectedModel={selectedModel}
          activeModel={activeModel}
          selectedModelOptions={selectedModelOptions}
          modelSelectorOpenSignal={modelSelectorOpenSignal}
          isModelSelectionReady={isModelSelectionReady}
          onSelectModel={onSelectModel}
          onSelectModelAndOptions={onSelectModelAndOptions}
          onSelectModelOption={onSelectModelOption}
          onBlockedModelSelect={onBlockedModelSelect}
          contextUsage={contextUsage}
          onFileSelect={onFileSelect}
          planModeActive={planModeActive}
          onSetPlanMode={onSetPlanMode}
          onClearPlanMode={onClearPlanMode}
          onSetGoal={onSetGoal}
          onCompactContext={onCompactContext}
          goalDraftActive={goalDraftActive}
          onCancelGoalDraft={onCancelGoalDraft}
          isStreaming={isStreaming}
          onPause={onPause}
          onQuickPhraseSelect={handleQuickPhraseSelect}
          onSubmit={options => onSubmit(value, options)}
          leadingContext={toolbarLeadingContext}
        />
      </form>
    </div>
  )
}
