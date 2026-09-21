import { useMemo } from 'react'
import type { CollaborationMember, CollaborationAgent } from '../types'
import type { CollaborationTranslate } from '../i18n'
import type { IssueMentionGroup } from './issueCommentMentions'

/** Build the @-mention popup content from the project members and agents. */
export function useIssueMentionGroups(
  members: CollaborationMember[],
  agents: CollaborationAgent[],
  translate: CollaborationTranslate
): IssueMentionGroup[] {
  return useMemo(
    () => [
      {
        label: translate('todo.members'),
        items: members.map(member => ({
          id: `member-${member.user_id}`,
          name: member.user_name,
          testId: `collaboration-issue-mention-member-${member.user_id}`,
          mention: {
            type: 'user' as const,
            id: String(member.user_id),
            label: member.user_name,
          },
        })),
      },
      {
        label: translate('todo.agent_teams'),
        items: agents.map(agent => ({
          id: `agent-${agent.id}`,
          name: agent.name,
          avatar: 'AI',
          testId: `collaboration-issue-mention-agent-${agent.id}`,
          mention: {
            type: 'agent' as const,
            id: String(agent.id),
            label: agent.name,
          },
        })),
      },
    ],
    [members, agents, translate]
  )
}
