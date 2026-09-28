import { useMemo } from 'react'
import type { ComposerExternalMentionCandidate } from '../composer/composerAutocompleteInputTypes'
import type { CollaborationTranslate } from '../i18n'
import type { CollaborationAgent, CollaborationMember } from '../types'
import { issueMentionCandidates } from './issueCommentMentions'

/** The "@" targets a comment composer offers for one project. */
export function useIssueMentionCandidates(
  members: CollaborationMember[],
  agents: CollaborationAgent[],
  translate: CollaborationTranslate
): ComposerExternalMentionCandidate[] {
  return useMemo(
    () =>
      issueMentionCandidates({
        members,
        agents,
        membersLabel: translate('todo.members'),
        agentsLabel: translate('todo.agent_teams'),
      }),
    [members, agents, translate]
  )
}
