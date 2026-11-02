import type { ReactNode } from "react";

interface IssueWorkspacePropertiesProps {
  status: string;
  assigneeLabel: string;
  assigneeControl: ReactNode;
  scheduleControl: ReactNode;
  executionDuration: ReactNode;
}

export function IssueWorkspaceProperties({
  status,
  assigneeLabel,
  assigneeControl,
  scheduleControl,
  executionDuration,
}: IssueWorkspacePropertiesProps) {
  return (
    <section
      className="issue-workspace-properties"
      data-testid="cloud-todo-state-summary"
      data-status={status}
    >
      <div className="issue-detail-property-line">
        {assigneeControl ? (
          <div className="issue-detail-owner-control">
            <span className="issue-detail-owner-label">{assigneeLabel}</span>
            {assigneeControl}
          </div>
        ) : null}
        <div className="issue-detail-schedule-control">{scheduleControl}</div>
      </div>
      {executionDuration}
    </section>
  );
}
