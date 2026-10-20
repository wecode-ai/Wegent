import {
  IssueAssignmentHistoryList,
  type SharedIssueAssignmentHistoryEntry,
} from '@wegent/collaboration'
import type { CloudProjectMember } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { assignmentHistoryLabels } from './assignmentHistoryLabels'
import { memberNameById } from './todoShared'

export function IssueAssignmentEvent({
  entry,
  index,
  projectMembers,
}: {
  entry: SharedIssueAssignmentHistoryEntry
  index: number
  projectMembers: CloudProjectMember[]
}) {
  const { t } = useTranslation('common')

  return (
    <div
      data-testid={`cloud-task-assignment-event-${index}`}
      className="task-detail-timeline-system-event"
    >
      <span className="task-detail-timeline-marker" aria-hidden="true" />
      <div className="task-detail-timeline-system-content">
        <IssueAssignmentHistoryList
          entries={[entry]}
          memberName={userId => memberNameById(projectMembers, userId)}
          labels={assignmentHistoryLabels(t)}
        />
      </div>
    </div>
  )
}
