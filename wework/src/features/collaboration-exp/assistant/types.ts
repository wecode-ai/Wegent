import type {
  ExperiencePrivateConversation,
  ExperienceProjectData,
  ExperienceProjectScope,
} from '../model'

export interface AssistantHomeProps {
  active: boolean
  projects?: readonly ExperienceProjectData[]
  conversations?: readonly ExperiencePrivateConversation[]
  onOpenIssue?(project: ExperienceProjectScope, issueId: string): void
  onOpenConversation?(conversation: ExperiencePrivateConversation): void
}
