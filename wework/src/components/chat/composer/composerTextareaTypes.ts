import type { ComposerAutocompleteInputProps } from '@wegent/collaboration/composer/composerAutocompleteInputTypes'
import type { CloudProject } from '@/api/deliveries'
import type { ConversationMentionCandidate } from '@/lib/conversation-mentions'
import type { WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
export {
  primaryComposerSubmitOptions,
  type ComposerSubmitOptions,
  type ComposerFollowUpBehavior,
} from '@wegent/collaboration/composer'
export type { ComposerExternalMentionCandidate } from '@wegent/collaboration/composer/composerAutocompleteInputTypes'
export type ComposerTextareaProps = Omit<
  ComposerAutocompleteInputProps<CloudProject, ConversationMentionCandidate>,
  'translate' | 'workspaceTarget' | 'workspaceFileApi'
> & {
  workspaceTarget?: WorkspaceTarget | null
  workspaceFileApi?: WorkspaceFileApi
}
