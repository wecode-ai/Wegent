import { useTranslation } from '@/hooks/useTranslation'
import type {
  Attachment,
  DeviceInfo,
  LocalDeviceSkill,
  ModelOptions,
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
  selectedModelOptions: ModelOptions
  isModelSelectionReady?: boolean
  selectedSkills: SkillRef[]
  attachments: Attachment[]
  uploadingFiles: Map<string, { file: File; progress: number }>
  errors: Map<string, string>
  isOptionsLocked: boolean
  setSelectedModel: (model: UnifiedModel | null) => void
  setSelectedModelOption: (optionId: string, value: string) => void
  toggleSkill: (skill: SkillRef) => void
  handleFileSelect: (files: File | File[]) => Promise<void>
  removeAttachment: (attachmentId: number) => Promise<void>
  listLocalSkills: () => Promise<LocalDeviceSkill[]>
}

export interface ProjectWorkControls {
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  currentProjectId?: number
  currentStandaloneDeviceId?: string | null
  onSelectProject: (projectId: number | null) => void
  onSelectStandaloneDevice: (deviceId: string | null) => void
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
      selectedModelOptions: {},
      isModelSelectionReady: true,
      selectedSkills: [],
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
      isOptionsLocked: false,
      setSelectedModel: () => {},
      setSelectedModelOption: () => {},
      toggleSkill: () => {},
      handleFileSelect: async () => {},
      removeAttachment: async () => {},
      listLocalSkills: async () => [],
    }

  const composerProps = { value, onChange, onSubmit, disabled, placeholder: inputPlaceholder }

  if (variant === 'desktop') {
    return (
      <ProjectChatComposer
        {...composerProps}
        models={controls.models}
        selectedModel={controls.selectedModel}
        selectedModelOptions={controls.selectedModelOptions}
        isModelSelectionReady={controls.isModelSelectionReady ?? true}
        attachments={controls.attachments}
        uploadingFiles={controls.uploadingFiles}
        attachmentErrors={controls.errors}
        onSelectModel={controls.setSelectedModel}
        onSelectModelOption={controls.setSelectedModelOption}
        onFileSelect={files => {
          void controls.handleFileSelect(files)
        }}
        onRemoveAttachment={attachmentId => {
          void controls.removeAttachment(attachmentId)
        }}
        onListLocalSkills={controls.listLocalSkills}
        projectWork={
          projectWork ?? {
            projects: [],
            devices: [],
            currentProjectId: undefined,
            currentStandaloneDeviceId: null,
            onSelectProject: () => {},
            onSelectStandaloneDevice: () => {},
          }
        }
        showProjectWorkBar={showProjectWorkBar}
      />
    )
  }

  return (
    <CompactChatComposer
      {...composerProps}
      attachments={controls.attachments}
      uploadingFiles={controls.uploadingFiles}
      attachmentErrors={controls.errors}
      onImageSelect={files => {
        void controls.handleFileSelect(files)
      }}
      onRemoveAttachment={attachmentId => {
        void controls.removeAttachment(attachmentId)
      }}
      onListLocalSkills={controls.listLocalSkills}
    />
  )
}
