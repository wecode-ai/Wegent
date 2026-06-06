import type {
  Attachment,
  LocalDeviceSkill,
  ModelOptions,
  UnifiedModel,
} from '@/types/api'
import type { ProjectWorkControls } from '../ChatInput'
import { AttachmentBadges } from './AttachmentBadges'
import { ComposerToolbar } from './ComposerToolbar'
import { ComposerTextarea } from './ComposerTextarea'
import { ProjectWorkBar } from './ProjectWorkBar'
import { useAutoResizeTextarea } from './useAutoResizeTextarea'

interface ProjectChatComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled: boolean
  placeholder: string
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  isModelSelectionReady: boolean
  attachments: Attachment[]
  uploadingFiles: Map<string, { file: File; progress: number }>
  attachmentErrors: Map<string, string>
  onSelectModel: (model: UnifiedModel | null) => void
  onSelectModelOption: (optionId: string, value: string) => void
  onFileSelect: (files: File | File[]) => void
  onRemoveAttachment: (attachmentId: number) => void
  onListLocalSkills?: () => Promise<LocalDeviceSkill[]>
  projectWork: ProjectWorkControls
  showProjectWorkBar?: boolean
  isStreaming?: boolean
  onPause?: () => void
}

export function ProjectChatComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  models,
  selectedModel,
  selectedModelOptions,
  isModelSelectionReady,
  attachments,
  uploadingFiles,
  attachmentErrors,
  onSelectModel,
  onSelectModelOption,
  onFileSelect,
  onRemoveAttachment,
  onListLocalSkills,
  projectWork,
  showProjectWorkBar = true,
  isStreaming = false,
  onPause,
}: ProjectChatComposerProps) {
  const textareaRef = useAutoResizeTextarea(value, 168)
  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled

  return (
    <div className="relative w-full rounded-[28px] bg-surface shadow-[0_16px_44px_rgba(0,0,0,0.08)]">
      <form
        className="flex min-h-[112px] w-full flex-col rounded-[28px] border border-border bg-background pb-2 pl-4 pr-2 pt-3.5"
        onSubmit={event => {
          event.preventDefault()
          if (canSend) onSubmit()
        }}
      >
        <AttachmentBadges
          attachments={attachments}
          uploadingFiles={uploadingFiles}
          errors={attachmentErrors}
          onRemoveAttachment={onRemoveAttachment}
        />
        <ComposerTextarea
          textareaRef={textareaRef}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          canSend={canSend}
          placeholder={placeholder}
          rows={2}
          onPasteFiles={onFileSelect}
          className="max-h-[128px] min-h-9 w-full resize-none overflow-y-auto bg-transparent p-0 text-sm leading-5 text-text-primary outline-none placeholder:text-text-muted"
          skillMenuClassName="left-[-1rem] right-[-0.5rem]"
          onListLocalSkills={onListLocalSkills}
        />
        <ComposerToolbar
          canSend={canSend}
          models={models}
          selectedModel={selectedModel}
          selectedModelOptions={selectedModelOptions}
          isModelSelectionReady={isModelSelectionReady}
          onSelectModel={onSelectModel}
          onSelectModelOption={onSelectModelOption}
          onFileSelect={onFileSelect}
          isStreaming={isStreaming}
          onPause={onPause}
        />
      </form>
      {showProjectWorkBar && (
        <ProjectWorkBar
          projects={projectWork.projects}
          devices={projectWork.devices}
          currentProjectId={projectWork.currentProjectId}
          currentStandaloneDeviceId={projectWork.currentStandaloneDeviceId}
          onSelectProject={projectWork.onSelectProject}
          onSelectStandaloneDevice={projectWork.onSelectStandaloneDevice}
          onCreateProjectMode={projectWork.onCreateProjectMode}
          className="min-h-11 px-4"
        />
      )}
    </div>
  )
}
