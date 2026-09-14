import { useMemo, useState } from "react";
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  FastForward,
  Play,
  Plus,
  RefreshCw,
  UserRound,
  XCircle,
} from "lucide-react";
import {
  WorkflowStageCompletionDialog,
  type WorkflowDeliverableDraft,
} from "./WorkflowStageCompletionDialog";
import { workflowDeliverableTypeLabel } from "./workflowDeliverables";
import {
  getCurrentWorkflowNode,
  isWorkflowNodeCompleted,
  workflowNodeStatusLabel,
} from "./workflowStagePresentation";
import type {
  IssueWorkflowTranslate,
  SharedWorkflowDelivery,
  SharedWorkflowNode,
  SharedWorkflowTaskBinding,
} from "./workflowTypes";

function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function workflowNodeExecutionMode(
  node: Pick<SharedWorkflowNode, "execution_mode" | "automation_rule_id">,
): "human" | "robot" {
  return node.execution_mode ?? (node.automation_rule_id ? "robot" : "human");
}

export interface IssueWorkflowStagesProps {
  translate: IssueWorkflowTranslate;
  nodes: SharedWorkflowNode[];
  tasks: SharedWorkflowTaskBinding[];
  deliveries?: SharedWorkflowDelivery[];
  executionError?: string | null;
  selectedTaskId?: string | null;
  onCreateTask?: (stageId: string) => void;
  onRunAutomation?: (
    stageId: string,
    automationRuleId: string,
  ) => void | Promise<void>;
  onOpenTask?: (task: SharedWorkflowTaskBinding) => void;
  onOpenDelivery?: (delivery: SharedWorkflowDelivery) => void;
  onCompleteStage?: (
    stageId: string,
    action: "submit" | "approve" | "force_advance",
    reason: string,
    values: WorkflowDeliverableDraft[],
  ) => Promise<void>;
  onDecide?: (
    stageId: string,
    action: "approve" | "reject" | "force_advance",
    reason: string,
  ) => Promise<void>;
}

function workflowTaskStatusLabel(
  t: (key: string) => string,
  status?: string,
): string {
  if (status === "running") return t("todo.workflow_task_status_running");
  if (status === "succeeded") return t("todo.workflow_task_status_succeeded");
  if (status === "failed") return t("todo.workflow_task_status_failed");
  if (status === "cancelled") return t("todo.workflow_task_status_cancelled");
  if (status === "archived") return t("todo.workflow_task_status_archived");
  return t("todo.workflow_task_status_pending");
}

function requirementDelivery(
  stage: SharedWorkflowNode,
  requirementId: string,
  deliveries: SharedWorkflowDelivery[],
): SharedWorkflowDelivery | undefined {
  const stageDeliveryIds = new Set(stage.delivery_ids ?? []);
  return deliveries.find(
    (delivery) =>
      delivery.status === "delivered" &&
      stageDeliveryIds.has(delivery.id) &&
      delivery.fulfillments.some(
        (fulfillment) => fulfillment.requirement_id === requirementId,
      ),
  );
}

export function IssueWorkflowStages({
  translate,
  nodes,
  tasks,
  deliveries = [],
  executionError,
  selectedTaskId,
  onCreateTask,
  onRunAutomation,
  onOpenTask,
  onOpenDelivery,
  onCompleteStage,
  onDecide,
}: IssueWorkflowStagesProps) {
  const t = translate;
  const [decisionDraft, setDecisionDraft] = useState<{
    stageId: string;
    action: "reject";
    reason: string;
  } | null>(null);
  const [completionDraft, setCompletionDraft] = useState<{
    stageId: string;
    action: "submit" | "approve" | "force_advance";
    reason: string;
    values: Record<string, WorkflowDeliverableDraft>;
  } | null>(null);
  const [busyStageId, setBusyStageId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const currentStageId = useMemo(
    () => getCurrentWorkflowNode(nodes)?.id ?? null,
    [nodes],
  );
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const effectiveSelectedStageId =
    selectedStageId && nodes.some((stage) => stage.id === selectedStageId)
      ? selectedStageId
      : currentStageId;
  const selectedStage = effectiveSelectedStageId
    ? nodes.find((stage) => stage.id === effectiveSelectedStageId)
    : undefined;

  const detailStages = selectedStage ? [selectedStage] : [];

  const decide = async (
    stageId: string,
    action: "approve" | "reject" | "force_advance",
    reason = "",
  ) => {
    if (!onDecide) return;
    setBusyStageId(stageId);
    setActionError(null);
    try {
      await onDecide(stageId, action, reason);
      setDecisionDraft(null);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : t("todo.workflow_action_failed"),
      );
    } finally {
      setBusyStageId(null);
    }
  };

  const completeStage = async () => {
    if (!completionDraft || !onCompleteStage) return;
    setBusyStageId(completionDraft.stageId);
    setActionError(null);
    try {
      await onCompleteStage(
        completionDraft.stageId,
        completionDraft.action,
        completionDraft.reason,
        Object.values(completionDraft.values),
      );
      setCompletionDraft(null);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : t("todo.workflow_action_failed"),
      );
    } finally {
      setBusyStageId(null);
    }
  };

  const runAutomation = async (stageId: string, automationRuleId: string) => {
    if (!onRunAutomation || busyStageId) return;
    setBusyStageId(stageId);
    setActionError(null);
    try {
      await onRunAutomation(stageId, automationRuleId);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : t("todo.workflow_action_failed"),
      );
    } finally {
      setBusyStageId(null);
    }
  };
  const completionStage = completionDraft
    ? nodes.find((stage) => stage.id === completionDraft.stageId)
    : undefined;
  const pendingCompletionRequirements = (
    completionStage?.required_deliverables ?? []
  ).filter(
    (requirement) =>
      !(completionStage?.fulfilled_deliverable_ids ?? []).includes(
        requirement.id,
      ) &&
      (!completionStage ||
        !requirementDelivery(completionStage, requirement.id, deliveries)),
  );

  return (
    <>
      <ol
        data-testid="cloud-todo-workflow-stages"
        className="issue-workflow-stages"
      >
        {nodes.map((stage, index) => {
          const automated = workflowNodeExecutionMode(stage) === "robot";
          const stageTasks = tasks.filter(
            (task) => task.workflow_node_id === stage.id,
          );
          return (
            <li key={stage.id}>
              <button
                type="button"
                data-testid={`cloud-todo-workflow-node-${stage.id}`}
                aria-pressed={stage.id === effectiveSelectedStageId}
                className={cn(
                  "issue-workflow-stage",
                  stage.id === effectiveSelectedStageId && "is-selected",
                )}
                onClick={() => setSelectedStageId(stage.id)}
              >
                <span className="issue-workflow-stage-index">{index + 1}</span>
                <span className="issue-workflow-stage-summary">
                  <strong>{stage.name}</strong>
                  <small>
                    {automated ? (
                      <Bot className="h-3.5 w-3.5" />
                    ) : (
                      <UserRound className="h-3.5 w-3.5" />
                    )}
                    {automated
                      ? t("todo.workflow_ai_execution")
                      : t("todo.workflow_stage_human_execution")}
                    {" · "}
                    {t("todo.workflow_task_count", {
                      count: stageTasks.length,
                    })}
                  </small>
                </span>
                <span
                  className={cn(
                    "issue-workflow-status",
                    `is-${stage.status.replace(/_/g, "-")}`,
                  )}
                >
                  {isWorkflowNodeCompleted(stage.status) ? (
                    <Check className="h-3 w-3" />
                  ) : null}
                  {workflowNodeStatusLabel(t, stage.status)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {detailStages.length > 0 ? (
        <section
          data-testid="cloud-todo-workflow-actions"
          className="issue-workflow-stage-panel"
        >
          <div>
            {detailStages.map((stage) => {
              const stageTasks = tasks.filter(
                (task) => task.workflow_node_id === stage.id,
              );
              const automated = workflowNodeExecutionMode(stage) === "robot";
              const startHumanStage =
                stageTasks.length === 0 && stage.status === "ready";
              const awaitingApproval = stage.status === "awaiting_approval";
              const canRunAutomation =
                automated &&
                Boolean(stage.automation_rule_id) &&
                ["ready", "failed"].includes(stage.status) &&
                Boolean(onRunAutomation);
              const canSubmitDeliverables =
                automated &&
                stage.status === "awaiting_deliverables" &&
                Boolean(onCompleteStage);
              const canCreateTask =
                !automated &&
                [
                  "ready",
                  "queued",
                  "running",
                  "awaiting_approval",
                  "changes_requested",
                  "failed",
                ].includes(stage.status) &&
                Boolean(onCreateTask);
              const requirements = stage.required_deliverables ?? [];
              const stageExecutionError =
                stage.execution_error ??
                (stage.status === "failed" ? executionError : null);
              const fulfilledIds = new Set(
                stage.fulfilled_deliverable_ids ?? [],
              );
              const requirementDeliveries = new Map(
                requirements.map((requirement) => [
                  requirement.id,
                  requirementDelivery(stage, requirement.id, deliveries),
                ]),
              );
              const fulfilledCount = requirements.filter(
                (requirement) =>
                  fulfilledIds.has(requirement.id) ||
                  Boolean(requirementDeliveries.get(requirement.id)),
              ).length;
              return (
                <article
                  key={stage.id}
                  data-testid={`cloud-todo-workflow-action-${stage.id}`}
                  className="issue-workflow-stage-content"
                >
                  <header className="issue-workflow-stage-header">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {stage.name}
                    </span>
                    <span
                      className={cn(
                        "issue-workflow-status",
                        `is-${stage.status.replace(/_/g, "-")}`,
                      )}
                    >
                      {isWorkflowNodeCompleted(stage.status) ? (
                        <Check className="h-3 w-3" />
                      ) : null}
                      {workflowNodeStatusLabel(t, stage.status)}
                    </span>
                    <span className="issue-workflow-stage-kind">
                      {automated ? (
                        <Bot className="h-3.5 w-3.5" />
                      ) : (
                        <UserRound className="h-3.5 w-3.5" />
                      )}
                      {automated
                        ? t("todo.workflow_ai_execution")
                        : t("todo.workflow_stage_human_execution")}
                    </span>
                  </header>
                  {stageExecutionError ? (
                    <div
                      data-testid={`cloud-todo-workflow-execution-error-${stage.id}`}
                      className="break-words rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700"
                    >
                      {stageExecutionError}
                    </div>
                  ) : null}
                  <div className="issue-workflow-stage-actions">
                    {canSubmitDeliverables ? (
                      <button
                        type="button"
                        data-testid={`cloud-todo-submit-workflow-deliverables-${stage.id}`}
                        onClick={() =>
                          setCompletionDraft({
                            stageId: stage.id,
                            action: "submit",
                            reason: "",
                            values: {},
                          })
                        }
                        className="issue-workflow-secondary-action"
                      >
                        <Check className="h-3.5 w-3.5" />
                        {t("todo.workflow_submit_deliverables", "补充交付物")}
                      </button>
                    ) : null}
                    {canRunAutomation ? (
                      <button
                        type="button"
                        data-testid={`cloud-todo-run-workflow-node-${stage.id}`}
                        disabled={busyStageId !== null}
                        onClick={() =>
                          void runAutomation(
                            stage.id,
                            stage.automation_rule_id!,
                          )
                        }
                        className="issue-workflow-secondary-action"
                      >
                        {busyStageId === stage.id ? (
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        ) : stage.status === "failed" ? (
                          <RefreshCw className="h-3.5 w-3.5" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                        {stage.status === "failed"
                          ? t("todo.workflow_run_again")
                          : t("todo.workflow_run")}
                      </button>
                    ) : null}
                    {awaitingApproval && onDecide ? (
                      <>
                        <button
                          type="button"
                          data-testid={`cloud-todo-approve-workflow-node-${stage.id}`}
                          disabled={busyStageId === stage.id}
                          onClick={() => {
                            if (fulfilledCount === requirements.length) {
                              void decide(stage.id, "approve");
                              return;
                            }
                            setCompletionDraft({
                              stageId: stage.id,
                              action: "approve",
                              reason: "",
                              values: {},
                            });
                          }}
                          className="issue-workflow-secondary-action is-approve"
                        >
                          <Check className="h-3.5 w-3.5" />
                          {t("todo.workflow_approve_stage")}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDecisionDraft({
                              stageId: stage.id,
                              action: "reject",
                              reason: "",
                            })
                          }
                          className="issue-workflow-secondary-action is-reject"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          {t("todo.workflow_reject_stage")}
                        </button>
                      </>
                    ) : null}
                    {!automated &&
                    onDecide &&
                    !["blocked", "completed", "forced_completed"].includes(
                      stage.status,
                    ) ? (
                      <button
                        type="button"
                        onClick={() =>
                          setCompletionDraft({
                            stageId: stage.id,
                            action: "force_advance",
                            reason: "",
                            values: {},
                          })
                        }
                        className="issue-workflow-secondary-action"
                      >
                        <FastForward className="h-3.5 w-3.5" />
                        {t("todo.workflow_force_advance")}
                      </button>
                    ) : null}
                  </div>
                  {requirements.length > 0 ? (
                    <div className="issue-workflow-deliverables">
                      <div className="issue-workflow-deliverables-title">
                        <p>{t("todo.workflow_required_deliverables")}</p>
                        <span
                          data-testid={`cloud-todo-workflow-deliverable-progress-${stage.id}`}
                        >
                          {fulfilledCount}/{requirements.length}
                        </span>
                      </div>
                      <div>
                        {requirements.map((requirement) => {
                          const delivery = requirementDeliveries.get(
                            requirement.id,
                          );
                          const fulfilled =
                            fulfilledIds.has(requirement.id) ||
                            Boolean(delivery);
                          const content = (
                            <>
                              {fulfilled ? (
                                <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
                              ) : (
                                <Circle className="h-4 w-4 shrink-0 text-text-muted" />
                              )}
                              <span className="min-w-0 flex-1 truncate">
                                {requirement.name}
                              </span>
                              <span className="shrink-0 text-text-muted">
                                {workflowDeliverableTypeLabel(
                                  requirement.value_type,
                                  t,
                                )}
                              </span>
                              <span
                                data-testid={`cloud-todo-workflow-deliverable-status-${stage.id}-${requirement.id}`}
                                className={cn(
                                  "shrink-0",
                                  fulfilled
                                    ? "text-green-600"
                                    : "text-text-muted",
                                )}
                              >
                                {fulfilled
                                  ? t("todo.workflow_deliverable_fulfilled")
                                  : t("todo.workflow_deliverable_missing")}
                              </span>
                              {delivery && onOpenDelivery ? (
                                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                              ) : null}
                            </>
                          );
                          return delivery && onOpenDelivery ? (
                            <button
                              key={requirement.id}
                              type="button"
                              data-testid={`cloud-todo-open-workflow-deliverable-${stage.id}-${requirement.id}`}
                              onClick={() => onOpenDelivery(delivery)}
                              className="issue-workflow-deliverable-row w-full text-left"
                            >
                              {content}
                            </button>
                          ) : (
                            <div
                              key={requirement.id}
                              className="issue-workflow-deliverable-row"
                            >
                              {content}
                            </div>
                          );
                        })}
                      </div>
                      {fulfilledCount < requirements.length ? (
                        <p className="issue-workflow-deliverables-missing">
                          {t("todo.workflow_deliverables_missing_count", {
                            count: requirements.length - fulfilledCount,
                          })}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {stageTasks.length > 0 ? (
                    <div
                      className="issue-workflow-stage-tasks"
                      data-testid={`cloud-todo-workflow-task-list-${stage.id}`}
                    >
                      {stageTasks.map((task) => {
                        const taskStatus =
                          stage.task_statuses?.[
                            `${task.device_id}:${task.task_id}`
                          ];
                        const successful = ["succeeded", "archived"].includes(
                          taskStatus ?? "",
                        );
                        const failed = ["failed", "cancelled"].includes(
                          taskStatus ?? "",
                        );
                        return (
                          <button
                            key={task.id}
                            type="button"
                            data-testid={`cloud-todo-open-workflow-task-${stage.id}-${task.id}`}
                            disabled={!onOpenTask}
                            onClick={() => onOpenTask?.(task)}
                            data-selected={
                              selectedTaskId === task.task_id ? "true" : "false"
                            }
                            className="issue-workflow-task-row"
                          >
                            <span
                              className={cn(
                                "issue-workflow-task-dot",
                                successful
                                  ? "is-success"
                                  : failed
                                    ? "is-failed"
                                    : taskStatus === "running"
                                      ? "is-running"
                                      : "is-pending",
                              )}
                            />
                            <span className="issue-workflow-task-info">
                              <span className="issue-workflow-task-name">
                                {task.task_title || task.task_id}
                              </span>
                              <span
                                data-testid={`cloud-todo-workflow-task-status-${stage.id}-${task.id}`}
                                data-status={taskStatus ?? "pending"}
                                className="issue-workflow-task-sub"
                              >
                                {task.device_id} ·{" "}
                                {workflowTaskStatusLabel(t, taskStatus)}
                              </span>
                            </span>
                            {onOpenTask ? (
                              <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="issue-workflow-stage-empty">
                      {t("todo.no_linked_task")}
                    </p>
                  )}
                  {canCreateTask ? (
                    <button
                      type="button"
                      data-testid={`cloud-todo-create-workflow-task-${stage.id}`}
                      onClick={() => onCreateTask?.(stage.id)}
                      className="issue-workflow-add-stage-task"
                    >
                      {startHumanStage ? (
                        <Play className="h-3.5 w-3.5" />
                      ) : (
                        <Plus className="h-3.5 w-3.5" />
                      )}
                      {startHumanStage
                        ? t("todo.workflow_start_work")
                        : t("todo.workflow_add_stage_task")}
                    </button>
                  ) : null}
                  {decisionDraft?.stageId === stage.id ? (
                    <div className="issue-workflow-reject-box">
                      <textarea
                        autoFocus
                        value={decisionDraft.reason}
                        data-testid={`cloud-todo-workflow-decision-reason-${stage.id}`}
                        onChange={(event) =>
                          setDecisionDraft((current) =>
                            current
                              ? { ...current, reason: event.target.value }
                              : current,
                          )
                        }
                        placeholder={t(
                          "todo.workflow_decision_reason_placeholder",
                        )}
                        className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                      />
                      <div className="mt-2 flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setDecisionDraft(null)}
                          className="h-7 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted"
                        >
                          {t("common.cancel")}
                        </button>
                        <button
                          type="button"
                          disabled={
                            !decisionDraft.reason.trim() ||
                            busyStageId === stage.id
                          }
                          onClick={() =>
                            void decide(
                              stage.id,
                              decisionDraft.action,
                              decisionDraft.reason,
                            )
                          }
                          className="h-7 rounded-lg bg-text-primary px-2 text-xs font-medium text-background disabled:opacity-40"
                        >
                          {t("common.confirm")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
          {actionError ? (
            <p className="px-3 pb-3 text-xs text-destructive">{actionError}</p>
          ) : null}
        </section>
      ) : null}
      {completionDraft ? (
        <WorkflowStageCompletionDialog
          translate={translate}
          stageName={completionStage?.name ?? completionDraft.stageId}
          requirements={pendingCompletionRequirements}
          action={completionDraft.action}
          busy={busyStageId === completionDraft.stageId}
          reason={completionDraft.reason}
          values={completionDraft.values}
          onReasonChange={(reason) =>
            setCompletionDraft((current) =>
              current ? { ...current, reason } : current,
            )
          }
          onValuesChange={(values) =>
            setCompletionDraft((current) =>
              current ? { ...current, values } : current,
            )
          }
          onClose={() => setCompletionDraft(null)}
          onSubmit={() => void completeStage()}
        />
      ) : null}
    </>
  );
}
