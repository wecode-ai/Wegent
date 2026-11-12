import type { ChatGroupApi } from '@/api/chatGroups'
import i18n from '@/i18n'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { createLocalAutomationConfiguration } from './localAutomationConfiguration'

export function localGroupAutomations(
  groups: ChatGroupApi,
  groupId: string,
  base: SharedWorkspaceApi,
  onMutation: () => void
): NonNullable<SharedWorkspaceApi['automations']> {
  const requireOwner = (id: string) => {
    if (id !== groupId) throw new Error('Automation belongs to another group')
  }
  return createLocalAutomationConfiguration({
    locale: i18n.language.startsWith('zh') ? 'zh-CN' : 'en',
    async read(id) {
      requireOwner(id)
      const { group } = await groups.get(groupId)
      return {
        rules: group.configuration?.automatic_processing_rules ?? [],
        version: group.version,
      }
    },
    async save(id, rules, version) {
      requireOwner(id)
      const { group } = await groups.get(groupId)
      const updated = await groups.update(groupId, {
        name: group.name,
        description: group.description,
        status: group.status,
        version,
        configuration: { automatic_processing_rules: rules },
      })
      onMutation()
      return updated.group.version
    },
    async targetName(id, kind, targetId) {
      requireOwner(id)
      if (kind === 'agent')
        return (await base.agents.list(id)).find(agent => agent.id === targetId)?.name ?? targetId
      const { group, members } = await groups.get(id)
      if (kind === 'human')
        return members.find(member => String(member.user_id) === targetId)?.name ?? targetId
      return (
        group.configuration?.collaboration_groups?.find(crew => crew.id === targetId)?.name ??
        targetId
      )
    },
    runtime: base.automations
      ? {
          run: async (id, ruleId) => [await base.automations!.runNow(id, ruleId)],
          listRuns: (id, ruleId) => base.automations!.listRuns(id, ruleId),
          cancelRun: (id, runId) => base.automations!.cancelRun(id, runId),
          retryRun: (id, runId) => base.automations!.retryRun(id, runId),
        }
      : undefined,
  })
}
