import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
import { IssueStatusHistoryList } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import { AnchorPopover } from './AnchorPopover'
import { memberNameById } from './todoShared'

type StatusHistoryEntry = NonNullable<CloudLoopItem['status_history']>[number]

const STATUS_ACTION_KEYS: Record<StatusHistoryEntry['trigger'], string> = {
  create: 'todo.status_action_create',
  user_update: 'todo.status_action_user_update',
  ai_started: 'todo.status_action_ai_started',
  ai_completed: 'todo.status_action_ai_completed',
  task_started: 'todo.status_action_task_started',
  delivery: 'todo.status_action_delivery',
  status_removed: 'todo.status_action_status_removed',
  workflow_plan_approved: 'todo.status_action_workflow_plan_approved',
  workflow_task_progress: 'todo.status_action_workflow_task_progress',
  workflow_outcome_passed: 'todo.status_action_workflow_outcome_passed',
  workflow_outcome_needs_rework: 'todo.status_action_workflow_outcome_needs_rework',
  workflow_review_approved: 'todo.status_action_workflow_review_approved',
  workflow_stage_advanced: 'todo.status_action_workflow_stage_advanced',
  workflow_replanned: 'todo.status_action_workflow_replanned',
  workflow_paused: 'todo.status_action_workflow_paused',
  workflow_resumed: 'todo.status_action_workflow_resumed',
}

interface StatusHistoryPopoverProps {
  anchor: HTMLElement | null
  entries: StatusHistoryEntry[]
  projectMembers: CloudProjectMember[]
  onClose: () => void
}

export function StatusHistoryPopover({
  anchor,
  entries,
  projectMembers,
  onClose,
}: StatusHistoryPopoverProps) {
  const { t } = useTranslation('common')
  return (
    <AnchorPopover
      anchor={anchor}
      title={t('todo.status_history_title', '状态历史')}
      testId="cloud-todo-status-history-popover"
      onClose={onClose}
    >
      <IssueStatusHistoryList
        entries={entries}
        memberName={userId => memberNameById(projectMembers, userId)}
        labels={{
          system: t('todo.status_history_system', '系统/机器人'),
          unset: t('todo.status_history_unset', '未设置'),
          initial: t('todo.status_history_initial', '初始状态'),
          accept: t('todo.status_action_accept', '验收'),
          action: trigger =>
            t(
              STATUS_ACTION_KEYS[trigger as StatusHistoryEntry['trigger']] ??
                'todo.status_action_user_update',
              trigger
            ),
        }}
      />
    </AnchorPopover>
  )
}
