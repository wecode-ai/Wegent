import { ChevronDown, CircleUserRound } from "lucide-react";
import { IssueDetailSearchableSelect } from "./IssueDetailControls";
import { IssuePropertyRow } from "./IssuePropertyRow";
import type { CollaborationMember } from "../types";
import "./issue-identity.css";

interface IssueIdentityPropertiesProps {
  creator: string;
  reporter: string;
  reporterId: number;
  members: CollaborationMember[];
  editable: boolean;
  disabled: boolean;
  translate(key: string): string;
  onReporterChange(userId: number): void;
}

export function IssueIdentityProperties({
  creator,
  reporter,
  reporterId,
  members,
  editable,
  disabled,
  translate: t,
  onReporterChange,
}: IssueIdentityPropertiesProps) {
  const reporterOptions = members.map((member) => ({
    value: String(member.user_id),
    label: member.user_name,
  }));
  if (!members.some((member) => member.user_id === reporterId)) {
    reporterOptions.unshift({ value: String(reporterId), label: reporter });
  }

  return (
    <div
      className="issue-identity-properties"
      data-testid="cloud-todo-identity-properties"
    >
      <IssuePropertyRow label={t("todo.reporter")}>
        {editable ? (
          <IssueDetailSearchableSelect
            testId="cloud-todo-reporter"
            accessibleLabel={t("todo.reporter")}
            className="issue-identity-person issue-identity-person-picker"
            value={String(reporterId)}
            options={reporterOptions}
            disabled={disabled}
            onChange={(value) => onReporterChange(Number(value))}
            searchPlaceholder={t("todo.search_reporter")}
            emptyLabel={t("todo.no_matching_reporter")}
            triggerContent={
              <>
                <CircleUserRound size={15} aria-hidden="true" />
                <span title={reporter}>{reporter}</span>
                <ChevronDown size={13} aria-hidden="true" />
              </>
            }
          />
        ) : (
          <span className="issue-identity-person">
            <CircleUserRound size={15} aria-hidden="true" />
            <span title={reporter}>{reporter}</span>
          </span>
        )}
      </IssuePropertyRow>
      <IssuePropertyRow
        label={t("todo.creator")}
        testId="cloud-todo-detail-creator"
      >
        <span
          className="issue-identity-person"
          data-testid="cloud-todo-identity-creator"
        >
          <CircleUserRound size={15} aria-hidden="true" />
          <span title={creator}>{creator}</span>
        </span>
      </IssuePropertyRow>
    </div>
  );
}
