import type { Attachment, LocalDeviceSkill, ModelOptions, UnifiedModel } from '@/types/api'
import type { CodeCommentContext } from '@/types/workspace-files'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { DragDropEvent } from '@tauri-apps/api/webview'
import type { Event } from '@tauri-apps/api/event'
import type { DragEventHandler } from 'react'
import { useEffect, useRef } from 'react'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'
import type { ProjectWorkControls } from '../ChatInput'
import { AttachmentBadges } from './AttachmentBadges'
import { ComposerToolbar } from './ComposerToolbar'
import { ComposerTextarea, type ComposerSubmitOptions } from './ComposerTextarea'
import { ProjectWorkBar } from './ProjectWorkBar'
import { useAutoResizeTextarea } from './useAutoResizeTextarea'
import { debugComposerEvent, textMetrics } from './composerDebug'

interface ProjectChatComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (submittedValue?: string, options?: ComposerSubmitOptions) => void
  disabled: boolean
  disabledReason?: string
  placeholder: string
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  modelSelectorOpenSignal?: number
  isModelSelectionReady: boolean
  attachments: Attachment[]
  codeComments?: CodeCommentContext[]
  uploadingFiles: Map<string, { file: File; progress: number }>
  attachmentErrors: Map<string, string>
  onSelectModel: (model: UnifiedModel | null) => void
  onSelectModelOption: (optionId: string, value: string) => void
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  onFileSelect: (files: File | File[]) => void
  planModeActive?: boolean
  onSetPlanMode?: () => void
  onClearPlanMode?: () => void
  onSetGoal?: () => void
  goalDraftActive?: boolean
  onCancelGoalDraft?: () => void
  onRemoveAttachment: (attachmentId: number) => void
  onClearCodeComments?: () => void
  onListLocalSkills?: () => Promise<LocalDeviceSkill[]>
  projectWork: ProjectWorkControls
  showProjectWorkBar?: boolean
  isStreaming?: boolean
  onPause?: () => void
}

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

interface NativeDroppedFile {
  name: string
  bytes: number[]
}

type NativeDropHandler = (event: Event<DragDropEvent>) => void

const nativeDropHandlers = new Set<NativeDropHandler>()
let nativeDropUnlistenPromise: Promise<() => void> | null = null
let nativeDropUnlisten: (() => void) | null = null
let nativeDropReleaseTimer: ReturnType<typeof setTimeout> | null = null

async function readNativeDroppedFiles(paths: string[]): Promise<File[]> {
  const droppedFiles = await invoke<NativeDroppedFile[]>('read_dropped_files', { paths })
  return droppedFiles.map(file => new File([new Uint8Array(file.bytes)], file.name))
}

function subscribeNativeDropHandler(handler: NativeDropHandler): () => void {
  if (nativeDropReleaseTimer !== null) {
    clearTimeout(nativeDropReleaseTimer)
    nativeDropReleaseTimer = null
  }

  nativeDropHandlers.add(handler)

  if (!nativeDropUnlistenPromise) {
    try {
      nativeDropUnlistenPromise = getCurrentWindow()
        .onDragDropEvent(event => {
          nativeDropHandlers.forEach(currentHandler => currentHandler(event))
        })
        .then(unlisten => {
          nativeDropUnlisten = unlisten
          if (nativeDropHandlers.size === 0 && nativeDropReleaseTimer === null) {
            nativeDropUnlisten?.()
            nativeDropUnlisten = null
            nativeDropUnlistenPromise = null
          }
          return unlisten
        })
        .catch(error => {
          nativeDropUnlistenPromise = null
          console.error('Failed to listen for native file drops:', error)
          return () => {}
        })
    } catch (error) {
      nativeDropUnlistenPromise = null
      console.error('Failed to listen for native file drops:', error)
    }
  }

  return () => {
    nativeDropHandlers.delete(handler)
    if (nativeDropHandlers.size > 0) return
    if (nativeDropReleaseTimer !== null) return

    nativeDropReleaseTimer = setTimeout(() => {
      nativeDropReleaseTimer = null
      if (nativeDropHandlers.size > 0) return

      const currentUnlisten = nativeDropUnlisten
      const pendingUnlisten = nativeDropUnlistenPromise
      nativeDropUnlisten = null
      nativeDropUnlistenPromise = null
      if (currentUnlisten) {
        currentUnlisten()
        return
      }

      if (pendingUnlisten) {
        void pendingUnlisten.then(unlisten => unlisten())
      }
    }, 1000)
  }
}

export function ProjectChatComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  disabledReason,
  placeholder,
  models,
  selectedModel,
  selectedModelOptions,
  modelSelectorOpenSignal,
  isModelSelectionReady,
  attachments,
  codeComments = [],
  uploadingFiles,
  attachmentErrors,
  onSelectModel,
  onSelectModelOption,
  onBlockedModelSelect,
  onFileSelect,
  planModeActive = false,
  onSetPlanMode,
  onClearPlanMode,
  onSetGoal,
  goalDraftActive = false,
  onCancelGoalDraft,
  onRemoveAttachment,
  onClearCodeComments,
  onListLocalSkills,
  projectWork,
  showProjectWorkBar = true,
  isStreaming = false,
  onPause,
}: ProjectChatComposerProps) {
  const formRef = useRef<HTMLFormElement>(null)
  const disabledRef = useRef(disabled)
  const onFileSelectRef = useRef(onFileSelect)
  const textareaRef = useAutoResizeTextarea(value, 168)
  const canSend =
    (value.trim().length > 0 || attachments.length > 0 || codeComments.length > 0) && !disabled
  const handleDragOver: DragEventHandler<HTMLFormElement> = event => {
    if (!hasDraggedFiles(event.dataTransfer)) return

    event.preventDefault()
    event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
  }
  const handleDrop: DragEventHandler<HTMLFormElement> = event => {
    if (!hasDraggedFiles(event.dataTransfer)) return

    event.preventDefault()
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

  useEffect(() => {
    disabledRef.current = disabled
  }, [disabled])

  useEffect(() => {
    onFileSelectRef.current = onFileSelect
  }, [onFileSelect])

  useEffect(() => {
    if (!isTauriRuntime()) return

    const unsubscribe = subscribeNativeDropHandler(event => {
      const { payload } = event
      if (
        payload.type !== 'drop' ||
        payload.paths.length === 0 ||
        disabledRef.current ||
        !formRef.current
      ) {
        return
      }

      void readNativeDroppedFiles(payload.paths)
        .then(files => {
          if (files.length > 0) onFileSelectRef.current(files)
        })
        .catch(error => {
          console.error('Failed to read dropped files:', error)
        })
    })

    return unsubscribe
  }, [])

  return (
    <div className="relative w-full rounded-[26px] bg-surface shadow-[0_18px_44px_rgba(0,0,0,0.09)]">
      <form
        ref={formRef}
        data-testid="project-chat-composer-form"
        className={cn(
          'relative z-10 flex min-h-[76px] w-full flex-col rounded-[26px] border border-border/45 bg-background px-4 pb-1.5 pt-2',
          showProjectWorkBar && 'border-b-border/35'
        )}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onSubmit={event => {
          event.preventDefault()
          const submittedValue = event.currentTarget.querySelector('textarea')?.value
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
          className="max-h-[112px] min-h-[48px] w-full resize-none overflow-y-auto bg-transparent px-0 pb-0 pt-1 text-[15px] leading-6 text-text-primary outline-none placeholder:text-text-muted/55"
          skillMenuClassName="left-[-1rem] right-[-0.5rem]"
          onListLocalSkills={onListLocalSkills}
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
          selectedModelOptions={selectedModelOptions}
          modelSelectorOpenSignal={modelSelectorOpenSignal}
          isModelSelectionReady={isModelSelectionReady}
          onSelectModel={onSelectModel}
          onSelectModelOption={onSelectModelOption}
          onBlockedModelSelect={onBlockedModelSelect}
          onFileSelect={onFileSelect}
          planModeActive={planModeActive}
          onSetPlanMode={onSetPlanMode}
          onClearPlanMode={onClearPlanMode}
          onSetGoal={onSetGoal}
          goalDraftActive={goalDraftActive}
          onCancelGoalDraft={onCancelGoalDraft}
          isStreaming={isStreaming}
          onPause={onPause}
        />
      </form>
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
          className="min-h-10 rounded-b-[26px] bg-surface px-4"
          buttonClassName="h-9 px-2.5 text-[13px] leading-[18px] text-text-secondary hover:bg-surface/70 hover:text-text-primary"
        />
      )}
    </div>
  )
}
