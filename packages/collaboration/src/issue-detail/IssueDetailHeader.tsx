import { Folder } from "lucide-react";
import type { ReactNode } from "react";

export function IssueDetailHeader({
  className,
  contextLabel,
  contextActions,
  panelActions,
  saveAction,
}: {
  className: string;
  contextLabel: string;
  contextActions: ReactNode;
  panelActions: ReactNode;
  saveAction?: ReactNode;
}) {
  return (
    <header className={`${className} issue-detail-header`}>
      <span className="issue-detail-header-breadcrumb" title={contextLabel}>
        <Folder size={16} aria-hidden="true" />
        <span>{contextLabel}</span>
      </span>
      <div className="issue-detail-header-controls">
        {saveAction}
        <div className="issue-detail-header-context">{contextActions}</div>
        <div className="issue-detail-header-actions">{panelActions}</div>
      </div>
    </header>
  );
}
