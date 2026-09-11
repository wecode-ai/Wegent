// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Bot, ExternalLink, Sparkles } from "lucide-react";

import type { WorkspaceWorkflowPlanStatus } from "../ports/SharedWorkspaceApi";
import type { WorkspaceWorkflowPlan } from "../ports/SharedWorkspaceApi";

export type IssueWorkflowPlanAction =
  | "approve"
  | "approveReview"
  | "pause"
  | "resume"
  | "replan";

export interface IssueWorkflowPlanItemView {
  id: string;
  title: string;
  description?: string;
  assigneeId?: string;
  assigneeName?: string;
  rationale?: string;
  taskId?: string | null;
  taskStatus?: string | null;
  outcomeVerdict?: string | null;
  outcomeSummary?: string | null;
}

export interface IssueWorkflowManagerView {
  id?: string;
  status?: string;
  recentActivity?: string;
  error?: string;
  model?: string;
  deviceId?: string;
}

export interface IssueWorkflowPlanView {
  status: WorkspaceWorkflowPlanStatus;
  summary: string;
  items: IssueWorkflowPlanItemView[];
  manager?: IssueWorkflowManagerView | null;
}

export interface IssueWorkflowPlanLabels {
  title: string;
  status: Record<WorkspaceWorkflowPlanStatus, string>;
  failed: string;
  retry: string;
  replan: string;
  approve: string;
  approveReview: string;
  resume: string;
  pause: string;
  rerun: string;
  manager: string;
  managerEnteringQueue: string;
  openExecution: string;
  outcomePassed: string;
  outcomeNeedsRework: string;
  taskPendingCreation: string;
  openTask: string;
  error: Record<
    "timeout" | "offline" | "assignee" | "model" | "generic",
    string
  >;
}

export interface IssueWorkflowPlanTestIds {
  plan?: string;
  status?: string;
  approve?: string;
  approveReview?: string;
  pause?: string;
  resume?: string;
  replan?: string;
  rerun?: string;
  manager?: string;
  managerOpenExecution?: string;
  errorSummary?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function workspaceWorkflowPlanView(
  plan: WorkspaceWorkflowPlan | null,
): IssueWorkflowPlanView | null {
  if (!plan) return null;
  const manager = plan.managerRun;
  return {
    status: plan.status,
    summary: plan.summary,
    items: plan.items.map((item, index) => ({
      id: optionalString(item.id) ?? String(index),
      title:
        optionalString(item.title) ??
        optionalString(item.name) ??
        `#${index + 1}`,
      description: optionalString(item.description),
      assigneeId: optionalString(item.assignee_id),
      assigneeName: optionalString(item.assignee_name),
      rationale: optionalString(item.rationale),
      taskId: optionalString(item.task_id) ?? null,
      taskStatus: optionalString(item.task_status) ?? null,
      outcomeVerdict: optionalString(item.outcome_verdict) ?? null,
      outcomeSummary: optionalString(item.outcome_summary) ?? null,
    })),
    manager:
      manager && typeof manager === "object"
        ? {
            id: optionalString(manager.id),
            status: optionalString(manager.status),
            recentActivity: optionalString(manager.recent_activity),
            error: optionalString(manager.error),
            model: optionalString(manager.model),
            deviceId: optionalString(manager.device_id),
          }
        : null,
  };
}

function workflowErrorKind(
  error: string,
): keyof IssueWorkflowPlanLabels["error"] {
  const normalized = error.toLowerCase();
  if (normalized.includes("no model or tool progress")) return "timeout";
  if (
    normalized.includes("executor-offline") ||
    normalized.includes("device offline")
  ) {
    return "offline";
  }
  if (normalized.includes("assignee is not active")) return "assignee";
  if (normalized.includes("model") && normalized.includes("available"))
    return "model";
  return "generic";
}

export function IssueWorkflowPlanSection({
  plan,
  fallbackStatus = "idle",
  error,
  busy = false,
  availableActions,
  labels,
  testIds = {},
  statusName,
  onAction,
  onOpenManagerExecution,
  onOpenTask,
}: {
  plan: IssueWorkflowPlanView | null;
  fallbackStatus?: WorkspaceWorkflowPlanStatus;
  error?: string | null;
  busy?: boolean;
  availableActions?: Partial<Record<IssueWorkflowPlanAction, boolean>>;
  labels: IssueWorkflowPlanLabels;
  testIds?: IssueWorkflowPlanTestIds;
  statusName?(status: string): string;
  onAction(action: IssueWorkflowPlanAction): void | Promise<void>;
  onOpenManagerExecution?: (() => void) | null;
  onOpenTask?(taskId: string): void;
}) {
  const status = plan?.status ?? fallbackStatus;
  const manager = plan?.manager;
  const managerPlanConflict =
    (status === "awaiting_approval" && manager?.status === "failed") ||
    (status === "planning" &&
      ["completed", "succeeded"].includes(manager?.status ?? ""));
  const rawError = manager?.error || error || "";
  const displayError =
    rawError || status === "failed"
      ? labels.error[workflowErrorKind(rawError)]
      : "";
  const enabled = (action: IssueWorkflowPlanAction) =>
    availableActions?.[action] !== false;
  const actionButton = (
    action: IssueWorkflowPlanAction,
    text: string,
    testId: string,
    primary = false,
  ) => (
    <button
      type="button"
      data-testid={testId}
      disabled={busy || !enabled(action)}
      onClick={() => void onAction(action)}
      className={
        primary
          ? "h-7 rounded-lg bg-text-primary px-2.5 text-xs font-medium text-background disabled:opacity-40"
          : "h-7 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted disabled:opacity-40"
      }
    >
      {text}
    </button>
  );

  return (
    <section
      className="mt-6 rounded-xl border border-border bg-muted/20 p-3"
      data-testid={testIds.plan ?? "cloud-todo-workflow-plan"}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <Sparkles className="h-4 w-4 shrink-0 text-text-secondary" />
        <h3 className="shrink-0 whitespace-nowrap text-sm font-semibold text-text-primary">
          {labels.title}
        </h3>
        <span
          className="shrink-0 whitespace-nowrap text-xs text-text-muted"
          data-testid={testIds.status ?? "cloud-todo-workflow-plan-status"}
        >
          {managerPlanConflict ? labels.failed : labels.status[status]}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap">
          {managerPlanConflict ? (
            actionButton(
              "replan",
              labels.retry,
              testIds.replan ?? "cloud-todo-workflow-replan",
              true,
            )
          ) : status === "awaiting_approval" ? (
            <>
              {actionButton(
                "replan",
                labels.replan,
                testIds.replan ?? "cloud-todo-workflow-replan",
              )}
              {actionButton(
                "approve",
                labels.approve,
                testIds.approve ?? "cloud-todo-workflow-approve",
                true,
              )}
            </>
          ) : status === "awaiting_review" ? (
            <>
              {actionButton(
                "replan",
                labels.replan,
                testIds.replan ?? "cloud-todo-workflow-replan",
              )}
              {actionButton(
                "approveReview",
                labels.approveReview,
                testIds.approveReview ?? "cloud-todo-workflow-review",
                true,
              )}
            </>
          ) : status === "paused" ? (
            actionButton(
              "resume",
              labels.resume,
              testIds.resume ?? "cloud-todo-workflow-resume",
              true,
            )
          ) : status === "planning" || status === "running" ? (
            actionButton(
              "pause",
              labels.pause,
              testIds.pause ?? "cloud-todo-workflow-pause",
            )
          ) : status === "failed" ? (
            actionButton(
              "replan",
              labels.retry,
              testIds.replan ?? "cloud-todo-workflow-replan",
              true,
            )
          ) : status === "completed" ? (
            actionButton(
              "replan",
              labels.rerun,
              testIds.rerun ?? "cloud-todo-workflow-rerun",
            )
          ) : null}
        </div>
      </div>
      {plan?.summary ? (
        <p className="mt-2 text-xs leading-5 text-text-secondary">
          {plan.summary}
        </p>
      ) : null}
      {manager || ["planning", "failed", "paused"].includes(status) ? (
        <button
          type="button"
          disabled={!onOpenManagerExecution}
          onClick={onOpenManagerExecution ?? undefined}
          className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-left transition-colors enabled:cursor-pointer enabled:hover:bg-muted/40 disabled:cursor-default"
          data-testid={testIds.manager ?? "cloud-todo-workflow-manager-run"}
        >
          <div className="flex items-center gap-2 text-xs">
            <Bot className="h-3.5 w-3.5 text-text-muted" />
            <span className="font-medium text-text-primary">
              {labels.manager}
            </span>
            <span className="min-w-0 flex-1 truncate text-text-muted">
              {manager?.recentActivity ||
                (status === "planning"
                  ? labels.managerEnteringQueue
                  : labels.status[status])}
            </span>
            {onOpenManagerExecution ? (
              <span
                data-testid={
                  testIds.managerOpenExecution ??
                  "cloud-todo-workflow-manager-open-execution"
                }
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {labels.openExecution}
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate text-xs text-text-muted">
            {[manager?.model, manager?.deviceId].filter(Boolean).join(" · ")}
          </p>
        </button>
      ) : null}
      {plan?.items.length ? (
        <div className="mt-2 divide-y divide-border rounded-lg border border-border bg-background">
          {plan.items.map((item, index) => {
            const itemStatus =
              item.outcomeVerdict === "passed"
                ? labels.outcomePassed
                : item.outcomeVerdict === "needs_rework"
                  ? labels.outcomeNeedsRework
                  : item.taskStatus
                    ? (statusName?.(item.taskStatus) ?? item.taskStatus)
                    : labels.taskPendingCreation;
            return (
              <div
                key={item.id}
                data-testid={`cloud-todo-workflow-plan-item-${item.id}`}
                className="flex gap-2 px-3 py-2"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-xs text-text-muted">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                      {item.title}
                    </p>
                    <span className="shrink-0 text-xs text-text-muted">
                      {itemStatus}
                    </span>
                  </div>
                  {!item.taskId && item.description ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-text-muted">
                      {item.description}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-text-secondary">
                    {item.assigneeName || item.assigneeId}
                    {item.rationale ? ` · ${item.rationale}` : ""}
                  </p>
                  {item.outcomeSummary ? (
                    <p className="mt-1 line-clamp-2 text-xs text-text-muted">
                      {item.outcomeSummary}
                    </p>
                  ) : null}
                </div>
                {item.taskId && onOpenTask ? (
                  <button
                    type="button"
                    data-testid={`cloud-todo-open-plan-task-${item.taskId}`}
                    onClick={() => onOpenTask(item.taskId!)}
                    className="shrink-0 self-start rounded-md px-1.5 py-1 text-xs text-text-secondary hover:bg-muted"
                  >
                    {labels.openTask}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {displayError ? (
        <details className="mt-2 text-xs text-destructive">
          <summary
            className={rawError ? "cursor-pointer" : undefined}
            data-testid={
              testIds.errorSummary ?? "cloud-todo-workflow-error-summary"
            }
          >
            {displayError}
          </summary>
          {rawError ? (
            <p className="mt-1 break-words text-text-muted">{rawError}</p>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}
