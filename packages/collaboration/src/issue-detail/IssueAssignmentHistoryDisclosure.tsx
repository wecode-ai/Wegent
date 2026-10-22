import { ChevronDown } from 'lucide-react'
import { useId } from 'react'
import { IssueAssignmentHistoryList, type IssueAssignmentHistoryEntry } from './IssueHistoryLists'
import { IssuePropertyRow } from './IssuePropertyRow'
import './IssueAssignmentHistoryDisclosure.css'

export function IssueAssignmentHistoryDisclosure({
  entries,
  memberName,
  translate: t,
}: {
  entries: IssueAssignmentHistoryEntry[]
  memberName(userId: number | null): string | null
  translate(key: string, fallback: string): string
}) {
  const historyId = useId()

  return (
    <details className="issue-assignment-history-disclosure">
      <summary
        data-testid="cloud-todo-assignment-chain-trigger"
        aria-controls={historyId}
        className="issue-assignment-history-summary"
      >
        <IssuePropertyRow label={t('todo.assignment', '指派')} clickable={false}>
          <span className="issue-assignment-history-show">
            {t('todo.assignment_chain_trigger', '查看指派详情')}
          </span>
          <span className="issue-assignment-history-hide">
            {t('todo.assignment_chain_collapse', '收起指派详情')}
          </span>
          <ChevronDown
            className="issue-assignment-history-chevron h-3 w-3 shrink-0"
            aria-hidden="true"
          />
        </IssuePropertyRow>
      </summary>
      <div
        id={historyId}
        role="region"
        aria-label={t('todo.assignment_chain_title', '指派详情')}
        data-testid="cloud-todo-assignment-chain-popover"
        className="issue-assignment-history-entries"
      >
        <IssueAssignmentHistoryList
          entries={entries}
          memberName={memberName}
          labels={{
            team: t('todo.assignment_chain_team', 'Wegent 智能体'),
            agent: t('todo.assignment_chain_agent', '机器人'),
            group: t('todo.assignment_chain_group', '协作小组'),
            unassigned: t('todo.assignment_chain_unassigned', '未指派'),
            actions: {
              assign: t('todo.assignment_action_assign', '指派'),
              reassign: t('todo.assignment_action_reassign', '转派'),
              unassign: t('todo.assignment_action_unassign', '取消指派'),
            },
          }}
        />
      </div>
    </details>
  )
}
