import {
  IssueAssignmentHistoryList,
  type SharedIssueAssignmentHistoryEntry,
} from '@wegent/collaboration'
import type { CloudProjectMember } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { assignmentHistoryLabels } from './assignmentHistoryLabels'
import { memberNameById } from './todoShared'
import type { ReactNode } from 'react'

export function IssueAssignmentEvent({
  entry,
  index,
  projectMembers,
  receipts,
}: {
  entry: SharedIssueAssignmentHistoryEntry
  index: number
  projectMembers: CloudProjectMember[]
  receipts?: ReactNode
}) {
  const { t } = useTranslation('common')

  return (
    <div
      data-testid={`cloud-task-assignment-event-${index}`}
      className="task-detail-timeline-system-event"
    >
      <span className="task-detail-timeline-marker" aria-hidden="true" />
      <div className="task-detail-timeline-system-content flex flex-wrap items-center gap-2">
        <IssueAssignmentHistoryList
          entries={[entry]}
          memberName={userId => memberNameById(projectMembers, userId)}
          labels={assignmentHistoryLabels(t)}
        />
        {receipts}
      </div>
    </div>
  )
}
