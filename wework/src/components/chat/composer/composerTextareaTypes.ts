import type { RefObject } from 'react'
import type { CloudProject } from '@/api/deliveries'
import type { LocalDeviceApp, LocalDeviceSkill, ModelOptions, UnifiedModel } from '@/types/api'
import type { WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import type {
  ComposerCloudMentionCandidate,
  ComposerConversationMentionCandidate,
} from './composerMentionCandidates'

export interface ComposerSubmitOptions {
  guideWhenBusy?: boolean
  interruptWhenBusy?: boolean
}

export interface ComposerExternalMentionCandidate {
  id: string
  type: 'agent' | 'user'
  title: string
  metaLabel: string
  searchAliases?: string[]
  testId?: string
}

export interface ComposerTextareaProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (submittedValue?: string, options?: ComposerSubmitOptions) => void
  canSend: boolean
  disabled?: boolean
  placeholder: string
  testId?: string
  rows: number
  textareaRef: RefObject<HTMLElement | null>
  className: string
  skillMenuClassName?: string
  onPasteFiles?: (files: File[]) => void
  onOpenSkillFile?: (path: string) => void
  workspaceTarget?: WorkspaceTarget | null
  workspaceFileApi?: WorkspaceFileApi
  cloudMentionCandidates?: ComposerCloudMentionCandidate[]
  conversationMentionCandidates?: ComposerConversationMentionCandidate[]
  cloudProjectCandidates?: ComposerCloudMentionCandidate[]
  cloudSpaceEnabled?: boolean
  externalMentionCandidates?: ComposerExternalMentionCandidate[]
  onSelectExternalMention?: (candidate: ComposerExternalMentionCandidate) => void
  onSelectCloudProject?: (project: CloudProject) => void
  onListLocalSkills?: () => Promise<LocalDeviceSkill[]>
  onListLocalApps?: () => Promise<LocalDeviceApp[]>
  models?: UnifiedModel[]
  selectedModel?: UnifiedModel | null
  selectedModelOptions?: ModelOptions
  planModeActive?: boolean
  onSetPlanMode?: () => void
  onSetGoal?: () => void
  onSelectModel?: (model: UnifiedModel | null) => void
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  isModelSelectionReady?: boolean
}
