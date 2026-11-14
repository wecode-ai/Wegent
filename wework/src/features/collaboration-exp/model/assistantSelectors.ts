import { matchesExperienceViewer } from './sourceIdentity'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import type {
  ExperienceAssistantInput,
  ExperienceAssistantSummary,
  ExperienceTaskRow,
  ExperienceWorkSnapshotItem,
} from './types'

type AssistantDecision =
  | { kind: 'proposal'; proposal: ExperienceAssistantSummary['pendingDecisions'][number] }
  | { kind: 'task'; task: ExperienceTaskRow }
  | { kind: 'work'; item: ExperienceWorkSnapshotItem }

const addressKey = (address: { deviceId: string; taskId: string }) =>
  JSON.stringify([address.deviceId, address.taskId])

function workIssueKey(work: RuntimeTaskReminderItem): string | null {
  const origin = work.task.runtimeHandle?.origin as Record<string, unknown> | undefined
  const store = origin?.projectStore === 'cloud' ? 'backend' : origin?.projectStore
  return (store === 'backend' || store === 'local') &&
    typeof origin?.cloudProjectId === 'string' &&
    typeof origin?.loopItemId === 'string'
    ? JSON.stringify([store, origin.cloudProjectId, origin.loopItemId])
    : null
}

/** Preserve card order and count only distinct, actionable waiting sources. */
export function selectAssistantDecisions(input: {
  proposals: ExperienceAssistantSummary['pendingDecisions']
  tasks: readonly ExperienceTaskRow[]
  items: readonly ExperienceWorkSnapshotItem[]
  work: readonly RuntimeTaskReminderItem[]
}): AssistantDecision[] {
  const proposals = new Map(input.proposals.map(proposal => [proposal.id, proposal]))
  const tasks = new Map(input.tasks.map(task => [task.key, task]))
  const issueKeys = new Set(tasks.keys())
  const linkedAddresses = new Set(
    [...tasks.values()].flatMap(task =>
      task.conversations.items.map(conversation => addressKey(conversation.address))
    )
  )
  const nativeIssues = new Map(
    input.work.map(work => [addressKey(work.address), workIssueKey(work)])
  )
  const decisions: AssistantDecision[] = [
    ...[...proposals.values()].map(proposal => ({ kind: 'proposal' as const, proposal })),
    ...[...tasks.values()].map(task => ({ kind: 'task' as const, task })),
  ]
  const seen = new Set<string>()
  for (const item of input.items) {
    if (item.state !== 'waiting' || !item.address) continue
    const key = addressKey(item.address)
    const issueKey = nativeIssues.get(key)
    if (seen.has(key) || linkedAddresses.has(key) || (issueKey != null && issueKeys.has(issueKey)))
      continue
    seen.add(key)
    decisions.push({ kind: 'work', item })
  }
  return decisions
}

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
