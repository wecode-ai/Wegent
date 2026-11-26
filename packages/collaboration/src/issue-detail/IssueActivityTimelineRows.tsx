import { Fragment, type ReactNode } from 'react'
import type { CollaborationTranslate } from '../i18n'
import { IssueCollapsedActivity } from './IssueActivityFeed'
import { IssueCreatedActivity } from './IssueActivityPresentation'
import {
  assignmentHistoryLabels,
  IssueAssignmentHistoryList,
  IssueStatusActivity,
  issueStatusHistoryLabels,
} from './IssueHistoryLists'
import type { IssueActivity, IssueActivityRow } from './issueActivityTimeline'

type CommentActivity = Extract<IssueActivity, { kind: 'comment' }>
type AssignmentActivity = Extract<IssueActivity, { kind: 'assignment' }>

export function IssueActivityTimelineRows({
  rows,
  creator,
  memberName,
  translate,
  expandLabel,
  onExpand,
  renderComment,
  renderAssignmentDetails,
}: {
  rows: readonly IssueActivityRow[]
  creator: string
  memberName: (id: number | null) => string | null
  translate: CollaborationTranslate
  expandLabel: (count: number) => string
  onExpand: () => void
  renderComment: (card: CommentActivity['card']) => ReactNode
  renderAssignmentDetails?: (activity: AssignmentActivity) => ReactNode
}) {
  const statusLabels = issueStatusHistoryLabels(translate)
  const assignmentLabels = assignmentHistoryLabels(translate)
  return (
    <div className="flex flex-col">
      {rows.map(row => {
        if (row.kind === 'collapsed')
          return (
            <IssueCollapsedActivity
              key="collapsed-middle"
              firstSequence={row.firstSequence}
              lastSequence={row.lastSequence}
              label={expandLabel(row.count)}
              onExpand={onExpand}
            />
          )
        const activity = row.activity
        switch (activity.kind) {
          case 'created':
            return (
              <IssueCreatedActivity
                key="issue-created"
                author={creator}
                createdAt={activity.at}
                translate={translate}
              />
            )
          case 'status':
            return (
              <IssueStatusActivity
                key={`status-${activity.index}`}
                entry={activity.entry}
                index={activity.index}
                memberName={memberName}
                labels={statusLabels}
              />
            )
          case 'assignment':
            return (
              <div
                key={`assignment-${activity.index}`}
                data-testid={`cloud-task-assignment-event-${activity.index}`}
                className="task-detail-timeline-system-event"
              >
                <span className="task-detail-timeline-marker" aria-hidden="true" />
                <div className="task-detail-timeline-system-content flex flex-wrap items-center gap-2">
                  <IssueAssignmentHistoryList
                    entries={[activity.entry]}
                    memberName={memberName}
                    labels={assignmentLabels}
                  />
                  {renderAssignmentDetails?.(activity)}
                </div>
              </div>
            )
          case 'comment':
            return (
              <Fragment key={activity.card.root.messageId}>{renderComment(activity.card)}</Fragment>
            )
        }
      })}
    </div>
  )
}
