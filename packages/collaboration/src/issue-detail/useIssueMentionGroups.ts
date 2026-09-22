import { useMemo } from 'react'
import type { CollaborationMember, CollaborationAgent } from '../types'
import type { CollaborationTranslate } from '../i18n'
export function useIssueMentionGroups(
  members: CollaborationMember[],
  agents: CollaborationAgent[],
  translate: CollaborationTranslate
) {
  return useMemo(
    () => [
      {
        label: translate('todo.members'),
        items: members.map(member => ({
          id: `member-${member.user_id}`,
          name: member.user_name,
          testId: `collaboration-issue-mention-member-${member.user_id}`,
        })),
      },
      {
        label: translate('todo.agent_teams'),
        items: agents.map(agent => ({
          id: `agent-${agent.id}`,
          name: agent.name,
          avatar: 'AI',
          testId: `collaboration-issue-mention-agent-${agent.id}`,
        })),
      },
    ],
    [members, agents, translate]
  )
}
