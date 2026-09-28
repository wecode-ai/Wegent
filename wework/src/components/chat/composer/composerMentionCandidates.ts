export * from '@wegent/collaboration/composer/composerMentionCandidates'
import type { ComposerMentionCandidate as SharedCandidate } from '@wegent/collaboration/composer/composerMentionCandidates'
import type { CloudProject } from '@/api/deliveries'
import type { ConversationMentionCandidate } from '@/lib/conversation-mentions'
export type ComposerMentionCandidate = SharedCandidate<CloudProject, ConversationMentionCandidate>
export type ComposerCloudMentionCandidate = Extract<ComposerMentionCandidate, { kind: 'cloud' }>
export type ComposerConversationMentionCandidate = Extract<
  ComposerMentionCandidate,
  { kind: 'conversation' }
>
