import type { Attachment, SkillRef, UnifiedModel, UnifiedSkill } from '@/types/api'
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
  skills: UnifiedSkill[]
  selectedModel: UnifiedModel | null
  selectedSkills: SkillRef[]
  attachments: Attachment[]
  uploadingFiles: Map<string, { file: File; progress: number }>
  attachmentErrors: Map<string, string>
  optionsLocked: boolean
  onSelectModel: (model: UnifiedModel | null) => void
  onToggleSkill: (skill: SkillRef) => void
  onFileSelect: (files: File | File[]) => void
  onRemoveAttachment: (attachmentId: number) => void
  projectWork: ProjectWorkControls
}

export function ProjectChatComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  models,
  skills,
  selectedModel,
  selectedSkills,
  attachments,
  uploadingFiles,
  attachmentErrors,
  optionsLocked,
  onSelectModel,
  onToggleSkill,
  onFileSelect,
  onRemoveAttachment,
  projectWork,
}: ProjectChatComposerProps) {
  const textareaRef = useAutoResizeTextarea(value, 168)
  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled

  return (
    <div className="w-full rounded-[28px] bg-surface shadow-[0_16px_44px_rgba(0,0,0,0.08)]">
      <form
        className="flex min-h-[112px] w-full flex-col rounded-[28px] border border-border bg-base px-6 pb-4 pt-5"
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
          className="max-h-[144px] min-h-12 w-full resize-none overflow-y-auto bg-transparent text-base leading-6 text-text-primary outline-none placeholder:text-text-muted"
        />
        <ComposerToolbar
          canSend={canSend}
          models={models}
          skills={skills}
          selectedModel={selectedModel}
          selectedSkills={selectedSkills}
          optionsLocked={optionsLocked}
          onSelectModel={onSelectModel}
          onToggleSkill={onToggleSkill}
          onFileSelect={onFileSelect}
        />
      </form>
      <ProjectWorkBar
        projects={projectWork.projects}
        devices={projectWork.devices}
        currentProjectId={projectWork.currentProjectId}
        onSelectProject={projectWork.onSelectProject}
      />
    </div>
  )
}
