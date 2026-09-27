import { AlertTriangle } from "lucide-react";
import {
  CollaborationIssueCardContent,
  type CollaborationIssueCardProps,
} from "./CollaborationIssueCard";
import { IssueCardGoalSummary } from "./IssueCardTaskSummary";
import type { CollaborationTranslate } from "../i18n";
import { Tooltip } from "../issue-detail/Tooltip";

export function IssueExecutionConfigurationBadge({
  itemId,
  translate: t,
}: {
  itemId: string;
  translate: CollaborationTranslate;
}) {
  return (
    <span
      data-testid={`cloud-todo-card-needs-execution-config-${itemId}`}
      className="mt-2 inline-flex w-fit items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      {t("board.card.needs_configuration", "待配置")}
    </span>
  );
}

export function IssueBoardCardContent({
  item,
  reference,
  display,
  labels,
  agentNames,
  goal,
  needsExecutionConfiguration,
  translate: t,
}: Pick<
  CollaborationIssueCardProps,
  "item" | "reference" | "display" | "labels" | "agentNames"
> & {
  goal?: { bindingId: string | number; objective: string } | null;
  needsExecutionConfiguration?: boolean;
  translate: CollaborationTranslate;
}) {
  return (
    <>
      <CollaborationIssueCardContent
        item={item}
        reference={reference}
        display={display}
        labels={labels}
        agentNames={agentNames}
        renderAssigneeTooltip={(label, child) => (
          <Tooltip label={label} align="start" className="min-w-0 max-w-full">
            {child}
          </Tooltip>
        )}
        titleTrailing={
          goal?.objective.trim() ? (
            <IssueCardGoalSummary
              itemId={item.id}
              bindingId={goal.bindingId}
              objective={goal.objective}
              compact
              translate={t}
            />
          ) : null
        }
      />
      {needsExecutionConfiguration ? (
        <IssueExecutionConfigurationBadge itemId={item.id} translate={t} />
      ) : null}
    </>
  );
}
