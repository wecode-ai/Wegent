import { useTranslation } from '@/hooks/useTranslation'
import type {
  Attachment,
  DeviceInfo,
  LocalDeviceSkill,
  ModelOptions,
  ProjectExecutionMode,
  ProjectWithTasks,
  SkillRef,
  UnifiedModel,
  UnifiedSkill,
} from '@/types/api'
import type { GuidanceWorkbenchMessage, QueuedWorkbenchMessage } from '@/types/workbench'
import { ConversationQueuePanel } from './ConversationQueuePanel'
import { CompactChatComposer } from './composer/CompactChatComposer'
import { ProjectChatComposer } from './composer/ProjectChatComposer'

export type ProjectCreateMode = 'scratch' | 'existing' | 'git'

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
  executionMode: ProjectExecutionMode
  executionModeLocked?: boolean
  onSelectProject: (projectId: number | null) => void
  onSelectStandaloneDevice: (deviceId: string | null) => void
  onExecutionModeChange: (mode: ProjectExecutionMode) => void
  onCreateProjectMode?: (mode: ProjectCreateMode) => void
  branchName?: string
  branchLoading?: boolean
  onRefreshBranch?: () => Promise<void>
  onListBranches?: () => Promise<string[]>
  onCheckoutBranch?: (branchName: string) => Promise<void>
  onCreateBranch?: (branchName: string) => Promise<void>
}

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled: boolean
  disabledReason?: string
  placeholder?: string
  variant?: 'compact' | 'desktop'
  projectChat?: ProjectChatControls
  projectWork?: ProjectWorkControls
  showProjectWorkBar?: boolean
  queuedMessages?: QueuedWorkbenchMessage[]
  guidanceMessages?: GuidanceWorkbenchMessage[]
  onCancelQueuedMessage?: (id: string) => void
  onSendQueuedAsGuidance?: (id: string) => void
  onEditQueuedMessage?: (id: string) => void
  onCancelGuidanceMessage?: (id: string) => void
  isStreaming?: boolean
  onPause?: () => void
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled,
  disabledReason,
  placeholder,
  variant = 'compact',
  projectChat,
  projectWork,
  showProjectWorkBar = true,
  queuedMessages = [],
  guidanceMessages = [],
  onCancelQueuedMessage,
  onSendQueuedAsGuidance,
  onEditQueuedMessage,
  onCancelGuidanceMessage,
  isStreaming = false,
  onPause,
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

  const composerProps = {
    value,
    onChange,
    onSubmit,
    disabled,
    disabledReason,
    placeholder: disabledReason ? '' : inputPlaceholder,
  }
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
        {queuePanel}
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
          projectWork={
            projectWork ?? {
              projects: [],
              devices: [],
              currentProjectId: undefined,
              currentStandaloneDeviceId: null,
              executionMode: 'current_workspace',
              executionModeLocked: false,
              onSelectProject: () => {},
              onSelectStandaloneDevice: () => {},
              onExecutionModeChange: () => {},
              onCreateProjectMode: undefined,
            }
          }
          showProjectWorkBar={showProjectWorkBar}
          onListLocalSkills={controls.listLocalSkills}
          isStreaming={isStreaming}
          onPause={onPause}
        />
      </div>
    )
  }

  return (
    <div className="w-full">
      {queuePanel}
      <CompactChatComposer
        {...composerProps}
        attachments={controls.attachments}
        uploadingFiles={controls.uploadingFiles}
        attachmentErrors={controls.errors}
        onFileSelect={files => {
          void controls.handleFileSelect(files)
        }}
        onRemoveAttachment={attachmentId => {
          void controls.removeAttachment(attachmentId)
        }}
        onListLocalSkills={controls.listLocalSkills}
        isStreaming={isStreaming}
        onPause={onPause}
      />
    </div>
  )
}
