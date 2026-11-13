import { matchesExperienceViewer } from './sourceIdentity'
import type { ExperienceAssistantInput, ExperienceAssistantSummary } from './types'

export function selectAssistantSummary(
  input: ExperienceAssistantInput
): ExperienceAssistantSummary {
  const empty: ExperienceAssistantSummary = {
    state: 'unknown',
    roles: [],
    pendingDecisions: [],
    recentDiscussions: [],
    work: [],
  }
  const recentDiscussions = (input.conversations ?? [])
    .filter(conversation => matchesExperienceViewer(conversation.ownerUserId, input.viewer))
    .map(conversation => ({
      ...conversation,
      bindingIds: [...conversation.bindingIds],
      sourceNodeIds: [...conversation.sourceNodeIds],
      address: { ...conversation.address },
    }))
  const settings = input.settings
  if (!settings) return { ...empty, recentDiscussions }
  if (!matchesExperienceViewer(settings.userId, input.viewer)) return { ...empty, state: 'hidden' }
  return {
    state: 'ready',
    roles: [
      { id: null, name: null, enabled: settings.primary?.enabled !== false, isDefault: true },
      ...settings.roles.map(role => ({
        id: role.id,
        name: role.name || null,
        enabled: role.enabled,
        isDefault: false,
      })),
    ],
    pendingDecisions: (input.proposals ?? [])
      .filter(
        proposal => proposal.status === 'pending' && proposal.settings.userId === settings.userId
      )
      .map(proposal => ({
        id: proposal.id,
        summary: proposal.summary,
        roleId: proposal.roleId ?? null,
      })),
    recentDiscussions,
    work: (input.inbox ?? []).map(work => ({
      id: work.id,
      taskId: work.taskId,
      roleId: work.roleId,
      title: work.title,
      status: work.status,
    })),
  }
}
