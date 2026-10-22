import type { TFunction } from 'i18next'

export function assignmentHistoryLabels(t: TFunction) {
  return {
    team: t('todo.assignment_chain_team', 'Wegent 智能体'),
    agent: t('todo.assignment_chain_agent', '机器人'),
    group: t('todo.assignment_chain_group', '协作小组'),
    unassigned: t('todo.assignment_chain_unassigned', '未指派'),
    actions: {
      assign: t('todo.assignment_action_assign', '指派'),
      reassign: t('todo.assignment_action_reassign', '转派'),
      unassign: t('todo.assignment_action_unassign', '取消指派'),
    },
  }
}
