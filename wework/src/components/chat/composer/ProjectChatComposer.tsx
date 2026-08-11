import type {
  Attachment,
  LocalDeviceApp,
  LocalDeviceSkill,
  ModelOptions,
  RuntimeContextUsage,
  UnifiedModel,
} from '@/types/api'
import type { CodeCommentContext, WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import { Eye } from 'lucide-react'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEventHandler,
  type ReactNode,
} from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { ProjectWorkControls } from '../ChatInput'
import { AttachmentBadges } from './AttachmentBadges'
import { ComposerToolbar } from './ComposerToolbar'
import {
  ComposerTextarea,
  type ComposerSubmitOptions,
  type ComposerTextareaHandle,
} from './ComposerTextarea'
import { ProjectWorkBar } from './ProjectWorkBar'
import { useAutoResizeTextarea } from './useAutoResizeTextarea'
import { debugComposerEvent, textMetrics } from './composerDebug'
import type { QuickPhrase } from '@/tauri/appPreferences'
import type { CloudProject } from '@/api/deliveries'
import {
  resolveDataTransferWorkspacePaths,
  resolveStoredWorkspacePaths,
} from '@/lib/workspace-path-transfer'
import { mergePopoutWorkspaceProjects } from '@/features/workbench/popoutWorkspaceContext'
import type {
  ComposerCloudMentionCandidate,
  ComposerConversationMentionCandidate,
} from './composerMentionCandidates'
import type { ComposerExternalMentionCandidate } from './composerTextareaTypes'
import { applyWorkspacePathTransfer } from './composerPathTransfer'

interface ProjectChatComposerProps {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  onCompositionEnd?: () => void
  onSubmit: (submittedValue?: string, options?: ComposerSubmitOptions) => void
  disabled: boolean
  pluginPickerIconOnly?: boolean
  submitDisabled?: boolean
  disabledReason?: string
  placeholder: string
  inputTestId?: string
  submitButtonTestId?: string
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  activeModel?: UnifiedModel | null
  selectedModelOptions: ModelOptions
  modelSelectorOpenSignal?: number
  onModelSelectorOpenChange?: (open: boolean) => void
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
  conversationMentionCandidates?: ComposerConversationMentionCandidate[]
  externalMentionCandidates?: ComposerExternalMentionCandidate[]
  cloudProjectCandidates?: ComposerCloudMentionCandidate[]
  cloudSpaceEnabled?: boolean
  onSelectExternalMention?: (candidate: ComposerExternalMentionCandidate) => void
  onSelectCloudProject?: (project: CloudProject) => void
  selectedCloudProjectId?: CloudProject['id']
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
  onRemoveAttachment: (attachmentId: number) => void
  onClearCodeComments?: () => void
  onListLocalSkills?: () => Promise<LocalDeviceSkill[]>
  onListLocalApps?: () => Promise<LocalDeviceApp[]>
  projectWork: ProjectWorkControls
  showProjectWorkBar?: boolean
  isStreaming?: boolean
  onPause?: () => void
  showWorkspaceMenu?: boolean
  inputLeadingContext?: ReactNode
  /** Called when Backspace is pressed on an empty composer (e.g. dismiss Plugin Creator). */
  onDismissInputLeadingContext?: () => void
  toolbarLeadingContext?: ReactNode
}

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

export const ProjectChatComposer = forwardRef<ComposerTextareaHandle, ProjectChatComposerProps>(
  function ProjectChatComposer(
    {
      value,
      onChange,
      onBlur,
      onCompositionEnd,
      onSubmit,
      disabled,
      pluginPickerIconOnly = false,
      submitDisabled = false,
      disabledReason,
      placeholder,
      inputTestId,
      submitButtonTestId,
      models,
      selectedModel,
      activeModel,
      selectedModelOptions,
      modelSelectorOpenSignal,
      onModelSelectorOpenChange,
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
      conversationMentionCandidates,
      externalMentionCandidates,
      cloudProjectCandidates,
      cloudSpaceEnabled,
      onSelectExternalMention,
      onSelectCloudProject,
      selectedCloudProjectId,
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
      onRemoveAttachment,
      onClearCodeComments,
      onListLocalSkills,
      onListLocalApps,
      projectWork,
      showProjectWorkBar = true,
      isStreaming = false,
      onPause,
      showWorkspaceMenu,
      inputLeadingContext,
      onDismissInputLeadingContext,
      toolbarLeadingContext,
    },
    ref
  ) {
    const { t } = useTranslation('common')
    const [isDraggingFiles, setIsDraggingFiles] = useState(false)
    const composerRef = useRef<ComposerTextareaHandle>(null)
    const [hasText, setHasText] = useState(value.trim().length > 0)

    useImperativeHandle(
      ref,
      () => ({
        getValue: () => composerRef.current?.getValue() ?? value,
        setValue: (nextValue, selectionOffset) =>
          composerRef.current?.setValue(nextValue, selectionOffset),
      }),
      [value]
    )
    const getLiveValue = () => composerRef.current?.getValue() ?? value
    const workspaceMenuProjects = useMemo(
      () => mergePopoutWorkspaceProjects(projectWork.projects, projectWork.runtimeWork),
      [projectWork.projects, projectWork.runtimeWork]
    )
    const textareaRef = useAutoResizeTextarea(value, 168)
    const canSend =
      (hasText || attachments.length > 0 || codeComments.length > 0) && !disabled && !submitDisabled

    useEffect(() => {
      // Sync local hasText with external value changes (e.g. clear after submit).

      setHasText(value.trim().length > 0)
    }, [value])

    const handleComposerChange = useCallback(
      (nextValue: string) => {
        setHasText(nextValue.trim().length > 0)
        onChange(nextValue)
      },
      [onChange]
    )

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

      const currentValue = getLiveValue()
      void resolveDataTransferWorkspacePaths(
        event.dataTransfer,
        'drop',
        workspaceTarget?.workspaceSource
      ).then(transfer =>
        applyWorkspacePathTransfer(currentValue, transfer, handleComposerChange, onFileSelect)
      )
    }
    const handleShowTextAttachment = (attachment: Attachment) => {
      const text = attachment.text_content
      if (!text) return

      const currentValue = getLiveValue()
      const nextValue = currentValue ? `${currentValue}\n${text}` : text
      handleComposerChange(nextValue)
      onRemoveAttachment(attachment.id)
      window.requestAnimationFrame(() => textareaRef.current?.focus())
    }
    const handleQuickPhraseSelect = (phrase: QuickPhrase) => {
      onClearPlanMode?.()
      onCancelGoalDraft?.()
      if (phrase.mode === 'plan') onSetPlanMode?.()
      if (phrase.mode === 'goal') onSetGoal?.()
      const currentValue = getLiveValue()
      const phraseValue = currentValue ? `${currentValue}\n${phrase.content}` : phrase.content
      handleComposerChange(phraseValue)
      if (phrase.attachmentPaths?.length) {
        void resolveStoredWorkspacePaths(
          phrase.attachmentPaths,
          workspaceTarget?.workspaceSource === 'remote'
        ).then(transfer =>
          applyWorkspacePathTransfer(phraseValue, transfer, handleComposerChange, onFileSelect)
        )
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
            showClearButton={projectWork.showProjectClearButton}
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
            const submittedValue = composerRef.current?.getValue() ?? value
            debugComposerEvent('project-form-submit', {
              canSend,
              propValue: textMetrics(value),
              submittedValue: textMetrics(submittedValue),
              attachmentsCount: attachments.length,
              codeCommentsCount: codeComments.length,
              disabled,
              isStreaming,
            })
            if (canSend) onSubmit(submittedValue)
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
          {supervisorPending && onConfigureSupervisor ? (
            <button
              type="button"
              data-testid="pending-supervisor-indicator"
              disabled={disabled}
              onClick={onConfigureSupervisor}
              className="mb-1 flex h-7 w-fit items-center gap-1.5 rounded-lg bg-muted/70 px-2 text-xs text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:opacity-50"
            >
              <Eye className="h-3.5 w-3.5 text-text-muted" />
              <span>{t('workbench.supervisor_pending')}</span>
              <span className="text-text-muted">· {t('workbench.supervisor_pending_edit')}</span>
            </button>
          ) : null}
          {inputLeadingContext ? (
            <div
              data-testid="composer-input-leading-context"
              className="mb-1 flex w-full items-center"
            >
              {inputLeadingContext}
            </div>
          ) : null}
          <ComposerTextarea
            ref={composerRef}
            testId={inputTestId}
            textareaRef={textareaRef}
            value={value}
            onChange={handleComposerChange}
            onBlur={onBlur}
            onCompositionEnd={onCompositionEnd}
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
            conversationMentionCandidates={conversationMentionCandidates}
            externalMentionCandidates={externalMentionCandidates}
            cloudProjectCandidates={cloudProjectCandidates}
            cloudSpaceEnabled={cloudSpaceEnabled}
            onSelectExternalMention={onSelectExternalMention}
            onSelectCloudProject={onSelectCloudProject}
            onKeyDown={(event, snapshot) => {
              if (
                !onDismissInputLeadingContext ||
                !inputLeadingContext ||
                event.key !== 'Backspace' ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey
              ) {
                return false
              }
              if (snapshot.value.length > 0 || snapshot.selectionStart !== 0) {
                return false
              }
              onDismissInputLeadingContext()
              return true
            }}
            className="max-h-[112px] min-h-[48px] w-full resize-none overflow-y-auto bg-transparent px-0 pb-0 pt-1 text-chat text-text-primary outline-none placeholder:text-text-muted/55"
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
            sendButtonTestId={submitButtonTestId}
            disabled={disabled}
            pluginPickerIconOnly={pluginPickerIconOnly}
            models={models}
            selectedModel={selectedModel}
            activeModel={activeModel}
            selectedModelOptions={selectedModelOptions}
            modelSelectorOpenSignal={modelSelectorOpenSignal}
            onModelSelectorOpenChange={onModelSelectorOpenChange}
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
            onConfigureSupervisor={onConfigureSupervisor}
            supervisorEnabled={supervisorEnabled}
            supervisorPending={supervisorPending}
            onCompactContext={onCompactContext}
            goalDraftActive={goalDraftActive}
            onCancelGoalDraft={onCancelGoalDraft}
            isStreaming={isStreaming}
            onPause={onPause}
            showWorkspaceMenu={showWorkspaceMenu}
            projectWorkMenuContext={
              showWorkspaceMenu
                ? {
                    branchName: projectWork.worktreeBranch ?? projectWork.branchName,
                    currentProjectId: projectWork.currentProjectId,
                    executionMode: projectWork.executionMode,
                    executionModeLocked: projectWork.executionModeLocked,
                    isGitProject: projectWork.isGitProject,
                    projectName: projectWork.currentProject?.name,
                    projects: workspaceMenuProjects,
                    onCheckoutBranch: projectWork.onCheckoutBranch,
                    onExecutionModeChange: projectWork.onExecutionModeChange,
                    onListBranches: projectWork.onListBranches,
                    onSelectProject: projectWork.onSelectProject,
                  }
                : undefined
            }
            onQuickPhraseSelect={handleQuickPhraseSelect}
            onSubmit={options => onSubmit(composerRef.current?.getValue() ?? value, options)}
            leadingContext={toolbarLeadingContext}
            onListLocalApps={onListLocalApps}
            cloudProjectCandidates={cloudProjectCandidates}
            selectedCloudProjectId={selectedCloudProjectId}
            onSelectCloudProject={onSelectCloudProject}
          />
        </form>
      </div>
    )
  }
)
