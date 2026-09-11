import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
import { IssueAssignmentHistoryList } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import { AnchorPopover } from './AnchorPopover'
import { memberNameById } from './todoShared'

type AssignmentEntry = NonNullable<CloudLoopItem['assignment_history']>[number]

interface AssignmentChainPopoverProps {
  anchor: HTMLElement | null
  entries: AssignmentEntry[]
  projectMembers: CloudProjectMember[]
  onClose: () => void
}

export function AssignmentChainPopover({
  anchor,
  entries,
  projectMembers,
  onClose,
}: AssignmentChainPopoverProps) {
  const { t } = useTranslation('common')
  return (
    <AnchorPopover
      anchor={anchor}
      title={t('todo.assignment_chain_title', '指派详情')}
      testId="cloud-todo-assignment-chain-popover"
      onClose={onClose}
    >
      <IssueAssignmentHistoryList
        entries={entries}
        memberName={userId => memberNameById(projectMembers, userId)}
        labels={{
          team: t('todo.assignment_chain_team', 'Wegent 智能体'),
          agent: t('todo.assignment_chain_agent', '机器人'),
          unassigned: t('todo.assignment_chain_unassigned', '未指派'),
          actions: {
            assign: t('todo.assignment_action_assign', '指派'),
            reassign: t('todo.assignment_action_reassign', '转派'),
            unassign: t('todo.assignment_action_unassign', '取消指派'),
          },
        }}
      />
    </AnchorPopover>
  )
}
