import { CollapsibleRoot, CollapsibleTrigger, CollapsiblePanel } from '../controls/Collapsible'
import { useId } from 'react'
import {
  assignmentHistoryLabels,
  IssueAssignmentHistoryList,
  type IssueAssignmentHistoryEntry,
} from './IssueHistoryLists'
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
    <CollapsibleRoot className="issue-assignment-history-disclosure">
      <CollapsibleTrigger
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
        </IssuePropertyRow>
      </CollapsibleTrigger>
      <CollapsiblePanel>
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
            labels={assignmentHistoryLabels(t)}
          />
        </div>
      </CollapsiblePanel>
    </CollapsibleRoot>
  )
}
