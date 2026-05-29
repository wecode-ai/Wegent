import { useTranslation } from 'react-i18next'
import type {
  Attachment,
  DeviceInfo,
  ProjectWithTasks,
  SkillRef,
  UnifiedModel,
  UnifiedSkill,
} from '@/types/api'
import { CompactChatComposer } from './composer/CompactChatComposer'
import { ProjectChatComposer } from './composer/ProjectChatComposer'

export interface ProjectChatControls {
  models: UnifiedModel[]
  skills: UnifiedSkill[]
  selectedModel: UnifiedModel | null
  selectedSkills: SkillRef[]
  attachments: Attachment[]
  uploadingFiles: Map<string, { file: File; progress: number }>
  errors: Map<string, string>
  isOptionsLocked: boolean
  setSelectedModel: (model: UnifiedModel | null) => void
  toggleSkill: (skill: SkillRef) => void
  handleFileSelect: (files: File | File[]) => Promise<void>
  removeAttachment: (attachmentId: number) => Promise<void>
}

export interface ProjectWorkControls {
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  currentProjectId?: number
  onSelectProject: (projectId: number) => void
}

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled: boolean
  placeholder?: string
  variant?: 'compact' | 'desktop'
  projectChat?: ProjectChatControls
  projectWork?: ProjectWorkControls
  showProjectWorkBar?: boolean
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  variant = 'compact',
  projectChat,
  projectWork,
  showProjectWorkBar = true,
}: ChatInputProps) {
  const { t } = useTranslation('common')
  const inputPlaceholder = placeholder ?? t('workbench.input_placeholder', '尽管问')
  const controls: ProjectChatControls =
    projectChat ?? {
      models: [],
      skills: [],
      selectedModel: null,
      selectedSkills: [],
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
      isOptionsLocked: false,
      setSelectedModel: () => {},
      toggleSkill: () => {},
      handleFileSelect: async () => {},
      removeAttachment: async () => {},
    }

  const composerProps = { value, onChange, onSubmit, disabled, placeholder: inputPlaceholder }

  if (variant === 'desktop') {
    return (
      <ProjectChatComposer
        {...composerProps}
        models={controls.models}
        skills={controls.skills}
        selectedModel={controls.selectedModel}
        selectedSkills={controls.selectedSkills}
        attachments={controls.attachments}
        uploadingFiles={controls.uploadingFiles}
        attachmentErrors={controls.errors}
        optionsLocked={controls.isOptionsLocked}
        onSelectModel={controls.setSelectedModel}
        onToggleSkill={controls.toggleSkill}
        onFileSelect={files => {
          void controls.handleFileSelect(files)
        }}
        onRemoveAttachment={attachmentId => {
          void controls.removeAttachment(attachmentId)
        }}
        projectWork={
          projectWork ?? {
            projects: [],
            devices: [],
            currentProjectId: undefined,
            onSelectProject: () => {},
          }
        }
        showProjectWorkBar={showProjectWorkBar}
      />
    )
  }

  return <CompactChatComposer {...composerProps} />
}
