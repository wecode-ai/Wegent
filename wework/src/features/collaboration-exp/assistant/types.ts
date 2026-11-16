import type {
  ExperiencePrivateConversation,
  ExperienceProjectData,
  ExperienceProjectScope,
} from '../model'

export interface AssistantHomeProps {
  active: boolean
  panel?: AssistantHomePanel
  onPanelChange?(panel: AssistantHomePanel): void
  projects?: readonly ExperienceProjectData[]
  conversations?: readonly ExperiencePrivateConversation[]
  onOpenIssue?(project: ExperienceProjectScope, issueId: string): void
  onOpenConversation?(conversation: ExperiencePrivateConversation): void
}

export type AssistantHomePanel = 'recent' | 'team' | null
