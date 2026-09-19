import { Bot, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import type { SharedWorkflowNode } from "../issue-detail/workflowTypes";
const classNames = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(" ");
export function IssueCardWorkflowStage({
  itemId,
  node,
  onOpen,
  configurationAction,
  statusLabel,
}: {
  itemId: string;
  node: SharedWorkflowNode | null;
  onOpen?: () => void;
  configurationAction?: ReactNode;
  statusLabel?: string;
}) {
  if (!node && !configurationAction) return null;
  return (
    <span
      data-testid={
        node ? `cloud-todo-card-workflow-stage-${itemId}` : undefined
      }
      className="mt-2.5 flex min-w-0 items-center gap-2 text-xs"
    >
      {node ? (
        onOpen ? (
          <button
            type="button"
            data-testid={`cloud-todo-card-workflow-open-${itemId}`}
            onClick={onOpen}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            {(node.execution_mode ??
              (node.automation_rule_id ? "robot" : "human")) === "robot" ? (
              <Bot className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            ) : (
              <UserRound className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            )}
            <span className="min-w-0 truncate font-medium text-text-secondary">
              {node.name}
            </span>
          </button>
        ) : (
          <>
            {(node.execution_mode ??
              (node.automation_rule_id ? "robot" : "human")) === "robot" ? (
              <Bot className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            ) : (
              <UserRound className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            )}
            <span className="min-w-0 truncate font-medium text-text-secondary">
              {node.name}
            </span>
          </>
        )
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {configurationAction ? (
        configurationAction
      ) : node ? (
        <span
          data-testid={`cloud-todo-card-workflow-status-${itemId}`}
          className={classNames(
            "ml-auto shrink-0 rounded-full px-2 py-0.5",
            ["running", "ready", "queued"].includes(node.status) &&
              "bg-blue-500/10 text-blue-700 dark:text-blue-300",
            ["awaiting_approval", "awaiting_deliverables"].includes(
              node.status,
            ) && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
            ["completed", "forced_completed"].includes(node.status) &&
              "bg-green-500/10 text-green-700 dark:text-green-300",
            ["failed", "changes_requested"].includes(node.status) &&
              "bg-red-500/10 text-red-700 dark:text-red-300",
            node.status === "blocked" && "bg-muted text-text-muted",
          )}
        >
          {statusLabel}
        </span>
      ) : null}
    </span>
  );
}
