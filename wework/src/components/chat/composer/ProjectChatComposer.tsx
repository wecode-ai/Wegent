import type {
  Attachment,
  LocalDeviceApp,
  LocalDeviceSkill,
  ModelOptions,
  RuntimeContextUsage,
  UnifiedModel,
} from '@/types/api'
import type { CodeCommentContext, WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

import type { ProjectWorkControls } from '../ChatInput'
import { AttachmentBadges } from './AttachmentBadges'
import { ComposerToolbar } from './ComposerToolbar'
import {
  ComposerTextarea,
  type ComposerSubmitOptions,
  type ComposerTextareaHandle,
} from './ComposerTextarea'
import { ProjectWorkBar } from './ProjectWorkBar'
import type { QuickPhrase } from '@/desktop/appPreferences'
import type { CloudProject } from '@/api/deliveries'
import { resolveStoredWorkspacePaths } from '@/lib/workspace-path-transfer'
import { mergePopoutWorkspaceProjects } from '@/features/workbench/popoutWorkspaceContext'
import type {
  ComposerCloudMentionCandidate,
  ComposerConversationMentionCandidate,
} from './composerMentionCandidates'
import {
  type ComposerExternalMentionCandidate,
  type ComposerFollowUpBehavior,
} from './composerTextareaTypes'
import type { ModelSelectorCloseReason } from '@wegent/collaboration/controls/model-selector-types'
import { applyWorkspacePathTransfer } from './composerPathTransfer'
import { applyQuickPhrase } from '@wegent/collaboration/composer/applyQuickPhrase'
import { ComposerErrorBanner } from '@wegent/collaboration/composer'
import { ProjectComposerBody } from '@wegent/collaboration/composer'
import { desktopComposerTransferServices } from './desktopComposerServices'

interface ProjectChatComposerProps {
  presentation?: 'chat' | 'document'
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  onCompositionStart?: () => void
  onCompositionEnd?: () => void
  onSubmit: (submittedValue?: string, options?: ComposerSubmitOptions) => void
  disabled: boolean
  pluginPickerIconOnly?: boolean
  submitDisabled?: boolean
  requireText?: boolean
  disabledReason?: string
  placeholder: string
  inputTestId?: string
  nativeEmptyCaret?: boolean
  submitButtonTestId?: string
  submitLabel?: string
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  activeModel?: UnifiedModel | null
  selectedModelOptions: ModelOptions
  modelSelectorOpenSignal?: number
  onModelSelectorOpenChange?: (open: boolean, closeReason?: ModelSelectorCloseReason) => void
  isModelSelectionReady: boolean
  attachments: Attachment[]
  codeComments?: CodeCommentContext[]
  uploadingFiles: Map<string, { file: File; progress: number }>
  attachmentErrors: Map<string, string>
  contextUsage?: RuntimeContextUsage
  onSelectModel: (model: UnifiedModel | null) => boolean | void
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
  mentionScope?: 'all' | 'external'
  cloudProjectCandidates?: ComposerCloudMentionCandidate[]
  cloudSpaceEnabled?: boolean
  onSelectExternalMention?: (candidate: ComposerExternalMentionCandidate) => void
  onSelectCloudProject?: (project: CloudProject) => void
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
  projectWork?: ProjectWorkControls
  projectPhrases?: QuickPhrase[]
  showProjectWorkBar?: boolean
  projectWorkBar?: ReactNode
  showExecutionTools?: boolean
  isStreaming?: boolean
  onPause?: () => void
  showWorkspaceMenu?: boolean
  collapseWhenIdle?: boolean
  inputLeadingContext?: ReactNode
  /** Called when Backspace is pressed on an empty composer (e.g. dismiss Plugin Creator). */
  onDismissInputLeadingContext?: () => void
  toolbarLeadingContext?: ReactNode
  projectWorkBarMiddleContext?: ReactNode
  projectWorkBarTrailingContext?: ReactNode
  projectWorkBarEndContext?: ReactNode
  modelSelectorOverride?: ReactNode
  sendKey?: 'enter' | 'cmd_enter'
  followUpBehavior?: ComposerFollowUpBehavior
}

export const ProjectChatComposer = forwardRef<ComposerTextareaHandle, ProjectChatComposerProps>(
  function ProjectChatComposer(
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
      disabledReason,
      placeholder,
      inputTestId,
      nativeEmptyCaret,
      submitButtonTestId,
      submitLabel,
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
      mentionScope,
      cloudProjectCandidates,
      cloudSpaceEnabled,
      onSelectExternalMention,
      onSelectCloudProject,
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
      projectPhrases = [],
      showProjectWorkBar = true,
      showExecutionTools = true,
      isStreaming = false,
      onPause,
      showWorkspaceMenu,
      collapseWhenIdle = false,
      inputLeadingContext,
      onDismissInputLeadingContext,
      toolbarLeadingContext,
      projectWorkBarMiddleContext,
      projectWorkBar,
      projectWorkBarTrailingContext,
      projectWorkBarEndContext,
      modelSelectorOverride,
      sendKey = 'enter',
      followUpBehavior = 'queue',
    },
    ref
  ) {
    const { t } = useTranslation('common')
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
    const getLiveValue = () => composerRef.current?.getValue() ?? value
    const [phraseError, setPhraseError] = useState<string | null>(null)
    const workspaceMenuProjects = useMemo(
      () =>
        projectWork
          ? mergePopoutWorkspaceProjects(projectWork.projects, projectWork.runtimeWork)
          : [],
      [projectWork]
    )
    const handleQuickPhraseSelect = (phrase: QuickPhrase) => {
      if (!composerRef.current) return
      setPhraseError(null)
      applyQuickPhrase(phrase, composerRef.current, {
        clearPlan: onClearPlanMode,
        cancelGoal: onCancelGoalDraft,
        setPlan: onSetPlanMode,
        setGoal: onSetGoal,
      })
      if (phrase.attachmentPaths?.length) {
        void resolveStoredWorkspacePaths(
          phrase.attachmentPaths,
          workspaceTarget?.workspaceSource === 'remote'
        )
          .then(transfer =>
            applyWorkspacePathTransfer(getLiveValue(), transfer, onChange, onFileSelect)
          )
          .catch(cause => setPhraseError(cause instanceof Error ? cause.message : String(cause)))
      }
    }

    return (
      <>
        <ComposerErrorBanner error={phraseError} />
        <ProjectComposerBody
          presentation={presentation}
          ref={composerRef}
          translate={(key, fallback, options) => t(key, { ...options, defaultValue: fallback })}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          onBlur={onBlur}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          disabled={disabled}
          submitDisabled={submitDisabled}
          requireText={requireText}
          isModelSelectionReady={isModelSelectionReady}
          placeholder={placeholder}
          inputTestId={inputTestId}
          nativeEmptyCaret={nativeEmptyCaret}
          attachments={attachments}
          uploadingCount={uploadingFiles.size}
          attachmentErrorCount={attachmentErrors.size}
          codeCommentCount={codeComments.length}
          disabledReason={disabledReason}
          supervisorPending={supervisorPending}
          onConfigureSupervisor={onConfigureSupervisor}
          inputLeadingContext={inputLeadingContext}
          onDismissInputLeadingContext={onDismissInputLeadingContext}
          hasToolbarLeadingContext={Boolean(toolbarLeadingContext)}
          planModeActive={planModeActive}
          goalDraftActive={goalDraftActive}
          collapseWhenIdle={collapseWhenIdle}
          isStreaming={isStreaming}
          sendKey={sendKey}
          followUpBehavior={followUpBehavior}
          onFileSelect={onFileSelect}
          onRemoveAttachment={onRemoveAttachment}
          transferServices={desktopComposerTransferServices}
          workBar={
            projectWorkBar ??
            (showProjectWorkBar && projectWork && (
              <ProjectWorkBar
                projects={projectWork.projects}
                devices={projectWork.devices}
                runtimeWork={projectWork.runtimeWork}
                currentProject={projectWork.currentProject}
                currentProjectId={projectWork.currentProjectId}
                currentStandaloneDeviceId={projectWork.currentStandaloneDeviceId}
                selectedDeviceWorkspaceId={projectWork.selectedDeviceWorkspaceId}
                pendingProjectWorkspaceProjectId={projectWork.pendingProjectWorkspaceProjectId}
                extensionContext={projectWork}
                onSelectProject={projectWork.onSelectProject}
                onSelectStandaloneDevice={projectWork.onSelectStandaloneDevice}
                onSelectProjectWorkspace={projectWork.onSelectProjectWorkspace}
                onBindProjectWorkspace={projectWork.onBindProjectWorkspace}
                onCreateProjectMode={projectWork.onCreateProjectMode}
                showClearButton={projectWork.showProjectClearButton}
                showProjectSelector={projectWork.showProjectSelector}
                projectMenuOpenSignal={projectWork.projectMenuOpenSignal}
                projectMenuAnchorElement={projectWork.projectMenuAnchorElement}
                middleContext={projectWorkBarMiddleContext}
                trailingContext={projectWorkBarTrailingContext}
                endContext={projectWorkBarEndContext}
                className="min-h-10 rounded-t-[26px] bg-background px-4"
                buttonClassName="text-sm leading-[18px] text-text-secondary hover:bg-background/70 hover:text-text-primary"
              />
            ))
          }
          renderAttachments={onShowTextAttachment => (
            <AttachmentBadges
              workspacePath={workspaceTarget?.path}
              attachments={attachments}
              uploadingFiles={uploadingFiles}
              errors={attachmentErrors}
              codeComments={codeComments}
              onRemoveAttachment={onRemoveAttachment}
              onShowTextAttachment={onShowTextAttachment}
              onClearCodeComments={onClearCodeComments}
            />
          )}
          renderEditor={editorProps => (
            <ComposerTextarea
              {...editorProps}
              onSubmit={(submittedValue, options) =>
                editorProps.onSubmit(submittedValue ?? getLiveValue(), options)
              }
              onOpenSkillFile={onOpenSkillFile}
              workspaceTarget={workspaceTarget}
              workspaceFileApi={workspaceFileApi}
              cloudMentionCandidates={cloudMentionCandidates}
              conversationMentionCandidates={conversationMentionCandidates}
              externalMentionCandidates={externalMentionCandidates}
              mentionScope={mentionScope}
              cloudProjectCandidates={cloudProjectCandidates}
              cloudSpaceEnabled={cloudSpaceEnabled}
              onSelectExternalMention={onSelectExternalMention}
              onSelectCloudProject={onSelectCloudProject}
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
          )}
          renderToolbar={toolbarProps => (
            <ComposerToolbar
              onInsertPluginReference={reference => {
                composerRef.current?.insertReference(reference)
                composerRef.current?.focus()
              }}
              className={toolbarProps.className}
              canSend={toolbarProps.canSend}
              sendButtonTestId={submitButtonTestId}
              sendButtonLabel={submitLabel}
              disabled={disabled}
              pluginPickerIconOnly={pluginPickerIconOnly}
              showExecutionTools={showExecutionTools}
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
              modelSelectorOverride={modelSelectorOverride}
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
                showWorkspaceMenu && projectWork
                  ? {
                      currentProjectId: projectWork.currentProjectId,
                      extensionContext: projectWork,
                      projectName: projectWork.currentProject?.name,
                      projects: workspaceMenuProjects,
                      onSelectProject: projectWork.onSelectProject,
                    }
                  : undefined
              }
              onQuickPhraseSelect={handleQuickPhraseSelect}
              projectPhrases={projectPhrases}
              onSubmit={toolbarProps.onSubmit}
              sendKey={sendKey}
              followUpBehavior={followUpBehavior}
              leadingContext={toolbarLeadingContext}
              onListLocalApps={onListLocalApps}
              workspaceTarget={workspaceTarget}
            />
          )}
        />
      </>
    )
  }
)
