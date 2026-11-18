// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import type {
  IssueIntakeDefinition,
  IssueWorkflowAction,
  WorkflowStageReview,
  WorkflowStageReviewDecisionKind,
  WorkflowStageReviewRole,
  WorkflowNodeInstance,
} from "../automation/types";
import type { CollaborationTranslate } from "../i18n";
import type {
  CollaborationIssue,
  CollaborationMember,
  CollaborationPriority,
  CollaborationProject,
} from "../types";
import { WorkflowDeliverablesForm } from "./WorkflowDeliverablesForm";
import { IssueIntakeForm } from "./IssueIntakeForm";
import type { SharedIssueDetailPort } from "./createSharedIssueDetailPort";
import {
  IssueWorkflowAuditRecords,
  IssueWorkflowReviewSummary,
} from "./IssueWorkflowActivity";
import { IssueWorkflowReleaseForm } from "./IssueWorkflowReleaseForm";
import { IssueWorkflowReviewForm } from "./IssueWorkflowReviewForm";
import { workflowErrorMessage } from "./workflowErrorMessage";

const completedStates = new Set(["completed", "forced_completed"]);
const stageNames: Record<string, string> = {
  requirement_intake: "需求提出",
  joint_review: "共同评审",
  development_preparation: "开发准备",
  development_implementation: "开发实现",
  quality_acceptance: "质量验收",
  release_launch: "发布上线",
};
type ReasonOperation =
  | {
      type: "decide_node";
      node: WorkflowNodeInstance;
      action: "reject" | "force_advance";
    }
  | {
      type: "set_stage_state";
      node: WorkflowNodeInstance;
      state: "waiting" | "blocked" | "ready";
    }
  | { type: "upgrade_strategy" }
  | { type: "apply_project" };
type ReviewOperation = {
  node: WorkflowNodeInstance;
  decision: WorkflowStageReviewDecisionKind;
};

const reviewRolesByStage: Record<string, WorkflowStageReviewRole[]> = {
  joint_review: ["development", "design", "qa"],
  quality_acceptance: ["qa", "product", "design"],
};

export function IssueWorkflowPanel({
  issue,
  project,
  members = [],
  editable,
  onAction,
  onSaveIntake,
  onConfigureWorkflow,
  translate,
  deliveries,
  onEvidenceSubmitted,
}: {
  issue: CollaborationIssue;
  project: CollaborationProject;
  members?: CollaborationMember[];
  editable: boolean;
  onAction(action: IssueWorkflowAction, version?: number): Promise<void>;
  onSaveIntake?(
    definition: IssueIntakeDefinition,
    priority: CollaborationPriority,
  ): Promise<CollaborationIssue>;
  onConfigureWorkflow?: () => void;
  translate: CollaborationTranslate;
  deliveries?: SharedIssueDetailPort["deliveries"];
  onEvidenceSubmitted?(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<ReasonOperation | null>(null);
  const [reason, setReason] = useState("");
  const [reworkTo, setReworkTo] = useState<
    "development_preparation" | "development_implementation"
  >("development_implementation");
  const [evidenceNodeId, setEvidenceNodeId] = useState<string | null>(null);
  const [reviewOperation, setReviewOperation] =
    useState<ReviewOperation | null>(null);
  const [reviewComment, setReviewComment] = useState("");
  const [reviewEvidence, setReviewEvidence] = useState("");
  const [reviewRole, setReviewRole] = useState<WorkflowStageReviewRole | "">(
    "",
  );
  const [releaseNodeId, setReleaseNodeId] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const workflow = issue.workflow;
  const snapshot = workflow?.strategy_snapshot;
  const enabled = project.agentic_strategy_enabled === true;
  const canManage =
    project.access_role === "Owner" || project.access_role === "Maintainer";
  const inbox = workflow?.strategy_state === "inbox";
  const nodes =
    workflow?.nodes.filter(
      (node) => !node.node_type || node.node_type === "task",
    ) ?? [];
  const currentUser = members.find(
    (member) => member.user_id === project.current_user_id,
  );
  const label = (id: string | null | undefined) => {
    if (id === "inbox" || !id)
      return translate("todo.strategy_inbox", "收集箱");
    return stageNames[id]
      ? translate(`todo.strategy_stage_${id}`, stageNames[id])
      : (nodes.find((node) => node.id === id)?.name ??
          translate("todo.strategy_stage_pending", "阶段待确认"));
  };
  const requestKey = (signature: unknown) => {
    const serialized = JSON.stringify([issue.id, issue.version, signature]);
    const existing = keys.current.get(serialized);
    if (existing) return existing;
    const key = crypto.randomUUID();
    keys.current.set(serialized, key);
    return key;
  };
  const run = async (action: IssueWorkflowAction, version?: number) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAction(action, version);
      setOperation(null);
      setReason("");
    } catch (cause) {
      setError(workflowErrorMessage(cause, translate, label));
      throw cause;
    } finally {
      setBusy(false);
    }
  };
  const submitOperation = async () => {
    if (!operation || !reason.trim()) return;
    const common = {
      reason: reason.trim(),
      idempotency_key: requestKey([operation, reason, reworkTo]),
    };
    const action: IssueWorkflowAction =
      operation.type === "upgrade_strategy" ||
      operation.type === "apply_project"
        ? { ...common, type: operation.type }
        : operation.type === "set_stage_state"
          ? {
              ...common,
              type: "set_stage_state",
              node_id: operation.node.id,
              state: operation.state,
            }
          : {
              ...common,
              type: "decide_node",
              node_id: operation.node.id,
              action: operation.action,
              ...(operation.action === "reject" &&
              operation.node.id === "quality_acceptance"
                ? { rework_to: reworkTo }
                : {}),
            };
    await run(action);
  };
  const openOperation = (value: ReasonOperation) => {
    setOperation(value);
    setReason("");
    setError(null);
  };
  const coordinator = workflow?.coordinator_decision;
  const ownerLabel = (node: WorkflowNodeInstance) => {
    if (node.required_assignee_type === "user")
      return (
        members.find(
          (member) => String(member.user_id) === node.required_assignee_id,
        )?.user_name ??
        issue.assignee_name ??
        translate("todo.strategy_owner_pending", "待匹配项目负责人")
      );
    if (node.required_assignee_type === "agent")
      return (
        issue.assignee_agent_name ??
        translate("todo.strategy_assistant_pending", "助理接入待完成")
      );
    if (node.required_assignee_type === "team")
      return (
        issue.assignee_team_name ??
        translate("todo.strategy_owner_pending", "待匹配项目负责人")
      );
    return translate("todo.strategy_owner_pending", "待匹配项目负责人");
  };
  const latestReviewsFor = (stageId: string) => {
    const latest = new Map<WorkflowStageReviewRole, WorkflowStageReview>();
    const stageAttempt = Math.max(
      1,
      nodes.find((node) => node.id === stageId)?.attempts ?? 1,
    );
    for (const review of workflow?.stage_reviews ?? []) {
      if (
        review.stage_id === stageId &&
        (review.attempt ?? stageAttempt) === stageAttempt &&
        review.issue_version === issue.version &&
        review.strategy_version === snapshot?.version
      ) {
        latest.set(review.function_role, review);
      }
    }
    return latest;
  };
  const reviewRolesFor = (node: WorkflowNodeInstance) =>
    (reviewRolesByStage[node.id] ?? []).filter(
      (role) =>
        currentUser &&
        snapshot?.role_mapping[role]?.includes(currentUser.user_name),
    );
  const reviewGateReady = (node: WorkflowNodeInstance) => {
    const required = reviewRolesByStage[node.id];
    if (!required) return true;
    const latest = latestReviewsFor(node.id);
    return required.every(
      (role) => latest.get(role)?.decision === "no_objection",
    );
  };
  const openReview = (
    node: WorkflowNodeInstance,
    decision: WorkflowStageReviewDecisionKind,
  ) => {
    setReviewOperation({ node, decision });
    setReviewRole(reviewRolesFor(node)[0] ?? "");
    setReviewComment("");
    setReviewEvidence("");
    setError(null);
  };
  const submitReview = async () => {
    if (!reviewOperation || !reviewRole) return;
    if (reviewOperation.decision !== "no_objection" && !reviewComment.trim())
      return;
    const review = {
      decision: reviewOperation.decision,
      function_role: reviewRole,
      comment: reviewComment.trim(),
      evidence_refs: reviewEvidence
        .split(/[\n,，]/)
        .map((value) => value.trim())
        .filter(Boolean),
    };
    try {
      await run({
        type: "record_stage_review",
        node_id: reviewOperation.node.id,
        review,
        idempotency_key: requestKey([reviewOperation.node.id, review]),
      });
      setReviewOperation(null);
    } catch {
      return;
    }
  };
  if (!snapshot && !nodes.length && !enabled) return null;
  return (
    <section
      className="task-detail-workspace-section"
      data-testid="todo-detail-workflow"
    >
      <div className="task-detail-workspace-section-head">
        <h3 className="task-detail-workspace-section-title">
          {translate("todo.strategy_title", "协作阶段")}
        </h3>
        {enabled && canManage && onConfigureWorkflow ? (
          <button
            type="button"
            className="task-detail-workspace-ghost-action"
            data-testid="todo-configure-workflow"
            onClick={onConfigureWorkflow}
          >
            {translate("todo.configure_project_strategy", "设置协作策略")}
          </button>
        ) : null}
      </div>
      {snapshot ? (
        <div
          className="space-y-2 py-2 text-sm text-text-secondary"
          data-testid="issue-strategy-snapshot"
        >
          <p>
            {translate(
              "todo.strategy_snapshot_version",
              "当前 Issue 使用策略 v{{version}}",
              {
                version: snapshot.version,
              },
            )}
          </p>
          <p>
            {translate(
              "todo.strategy_snapshot_notice",
              "项目策略更新不会自动改写此快照。",
            )}
          </p>
          <details>
            <summary
              className="cursor-pointer py-1"
              data-testid="issue-strategy-snapshot-toggle"
            >
              {translate(
                "todo.strategy_snapshot_view",
                "查看此 Issue 的策略文本",
              )}
            </summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-sans text-sm">
              {snapshot.text}
            </pre>
          </details>
          {enabled &&
          canManage &&
          project.collaboration_strategy &&
          project.collaboration_strategy.version > snapshot.version ? (
            <button
              type="button"
              disabled={busy}
              className="task-detail-workspace-ghost-action"
              data-testid="issue-strategy-upgrade"
              onClick={() => openOperation({ type: "upgrade_strategy" })}
            >
              {translate("todo.strategy_upgrade", "显式升级到 v{{version}}", {
                version: project.collaboration_strategy.version,
              })}
            </button>
          ) : null}
        </div>
      ) : nodes.length ? (
        <p className="py-2 text-sm text-text-secondary">
          {translate(
            "todo.strategy_legacy_snapshot",
            "此 Issue 保留原有阶段记录，项目策略发布不会改写其历史。",
          )}
        </p>
      ) : (
        <div className="space-y-2 py-2 text-sm text-text-secondary">
          <p>
            {translate(
              "todo.strategy_not_published",
              "此 Issue 尚未应用项目协作策略。",
            )}
          </p>
          {enabled && editable && project.collaboration_strategy ? (
            <button
              type="button"
              disabled={busy}
              className="task-detail-workspace-ghost-action"
              data-testid="issue-strategy-apply"
              onClick={() => openOperation({ type: "apply_project" })}
            >
              {translate("todo.strategy_apply", "显式应用项目策略")}
            </button>
          ) : null}
        </div>
      )}
      {snapshot ? (
        <div
          className="flex flex-wrap gap-x-4 gap-y-1 py-2 text-sm text-text-secondary"
          data-testid="issue-strategy-state-summary"
        >
          <span>
            {translate("todo.strategy_execution_status", "执行状态")}：
            {issue.status}
          </span>
          <span>
            {translate("todo.workflow_current_stage", "当前阶段")}：
            {label(workflow?.current_stage_id)}
          </span>
          {workflow?.quality_blocked ? (
            <span
              className="text-error"
              data-testid="issue-strategy-quality-blocked"
            >
              {translate(
                "todo.strategy_quality_blocked",
                "质量验收有阻塞，请研发修复后复查",
              )}
            </span>
          ) : null}
        </div>
      ) : null}
      {inbox && onSaveIntake ? (
        <IssueIntakeForm
          issue={issue}
          members={members}
          editable={editable && enabled}
          translate={translate}
          onSave={onSaveIntake}
          onAdmit={(version, key) =>
            run({ type: "admit", idempotency_key: key }, version)
          }
        />
      ) : null}
      {snapshot &&
      enabled &&
      editable &&
      (inbox || workflow?.current_stage_id) ? (
        <button
          type="button"
          disabled={busy}
          className="task-detail-workspace-ghost-action"
          data-testid="issue-strategy-evaluate"
          onClick={() =>
            void run({
              type: "evaluate",
              idempotency_key: requestKey("evaluate"),
            }).catch(() => undefined)
          }
        >
          {translate("todo.strategy_evaluate", "检查阶段条件")}
        </button>
      ) : null}
      {coordinator ? (
        <div
          className="space-y-2 py-3 text-sm"
          data-testid="issue-strategy-coordination-summary"
        >
          <h4 className="font-medium text-text-primary">
            {translate(
              "todo.strategy_coordination_summary",
              "阶段判断与下一步",
            )}
          </h4>
          <p className="text-text-secondary">
            {translate(
              "todo.strategy_version_reference",
              "依据策略 v{{version}}",
              {
                version: coordinator.strategy_version,
              },
            )}{" "}
            · {label(coordinator.stage)}
          </p>
          <p>
            {translate("todo.strategy_next_owner", "下一负责人")}：
            {coordinator.next_owner ??
              translate("todo.strategy_owner_pending", "待匹配项目负责人")}
          </p>
          <p>
            {translate("todo.strategy_next_action", "下一动作")}：
            {coordinator.next_action}
          </p>
          {coordinator.satisfied_conditions.length ? (
            <p className="text-text-secondary">
              {translate("todo.strategy_satisfied", "已满足")}：
              {coordinator.satisfied_conditions.join("；")}
            </p>
          ) : null}
          {coordinator.missing_conditions.length ? (
            <p className="text-text-secondary">
              {translate("todo.strategy_missing", "阻塞与缺失条件")}：
              {coordinator.missing_conditions.join("；")}
            </p>
          ) : null}
          {coordinator.evidence_refs.length ? (
            <p className="text-text-secondary">
              {translate(
                "todo.strategy_evidence_references",
                "已引用 {{count}} 项证据",
                {
                  count: coordinator.evidence_refs.length,
                },
              )}
            </p>
          ) : null}
          {coordinator.clarification ? (
            <p
              role="status"
              data-testid="issue-strategy-clarification"
              className="text-text-secondary"
            >
              {translate("todo.strategy_clarification", "需要人工澄清")}：
              {coordinator.clarification}
            </p>
          ) : null}
          {coordinator.integration_status === "recorded" ? (
            <p
              className="text-text-secondary"
              data-testid="issue-strategy-coordinator-recorded"
            >
              {translate(
                "todo.strategy_coordinator_recorded",
                "协调器建议已记录；阶段决定仍由有权限的成员确认。",
              )}
            </p>
          ) : null}
        </div>
      ) : null}
      <IssueWorkflowReviewSummary
        workflow={workflow}
        members={members}
        reviews={
          workflow?.current_stage_id
            ? [...latestReviewsFor(workflow.current_stage_id).values()]
            : []
        }
        translate={translate}
      />
      {nodes.length ? (
        <ol
          className="space-y-3 py-2 text-sm"
          data-testid="issue-strategy-stages"
        >
          {nodes.map((node) => {
            const completed = completedStates.has(node.status);
            const dependenciesReady = node.depends_on.every((id) =>
              completedStates.has(
                workflow?.nodes.find((candidate) => candidate.id === id)
                  ?.status ?? "blocked",
              ),
            );
            const canDecide =
              editable &&
              !completed &&
              dependenciesReady &&
              !["blocked", "queued", "running"].includes(node.status);
            const active =
              !completed &&
              dependenciesReady &&
              (node.status !== "blocked" || Boolean(node.activated_at));
            const stageReviewRoles = reviewRolesFor(node);
            const canReview =
              editable &&
              !completed &&
              node.id === workflow?.current_stage_id &&
              stageReviewRoles.length > 0;
            const stageReviewReady = reviewGateReady(node);
            const releaseStage = node.id === "release_launch";
            return (
              <li
                key={node.id}
                className="space-y-1 border-b border-border/40 pb-3"
                data-testid={`todo-workflow-node-${node.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="font-medium text-text-primary">
                    {label(node.id)}
                  </strong>
                  <span className="text-text-secondary">
                    {translate(`todo.workflow_status_${node.status}`, "待确认")}
                  </span>
                </div>
                <p className="text-text-secondary">
                  {translate("todo.strategy_owner", "负责人")}：
                  {ownerLabel(node)} ·{" "}
                  {translate("todo.workflow_attempts", "尝试 {{count}} 次", {
                    count: node.attempts ?? 0,
                  })}
                </p>
                {node.required_deliverables?.length ? (
                  <p className="text-text-secondary">
                    {translate("todo.workflow_deliverables", "所需证据")}：
                    {node.required_deliverables
                      .map((requirement) => requirement.name)
                      .join("、")}
                  </p>
                ) : null}
                {node.execution_error ? (
                  <p role="status" className="text-text-secondary">
                    {translate(
                      "todo.strategy_execution_pending",
                      "阶段执行尚未就绪，请确认负责人和可用执行能力。",
                    )}
                  </p>
                ) : null}
                {!completed && editable ? (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {deliveries?.submitWorkflowEvidence &&
                    canDecide &&
                    node.required_deliverables?.length ? (
                      <button
                        type="button"
                        disabled={busy}
                        className="task-detail-workspace-ghost-action"
                        data-testid={`todo-workflow-evidence-${node.id}`}
                        onClick={() => setEvidenceNodeId(node.id)}
                      >
                        {translate(
                          "todo.workflow_submit_evidence",
                          "提交交付物",
                        )}
                      </button>
                    ) : null}
                    {canReview
                      ? (
                          [
                            ["no_objection", "无异议"],
                            ["objection", "提出异议"],
                            ["conditional", "条件性同意"],
                          ] as const
                        ).map(([decision, fallback]) => (
                          <button
                            key={decision}
                            type="button"
                            disabled={busy}
                            className="task-detail-workspace-ghost-action"
                            data-testid={`todo-workflow-review-${decision}-${node.id}`}
                            onClick={() => openReview(node, decision)}
                          >
                            {translate(
                              `todo.strategy_review_${decision}`,
                              fallback,
                            )}
                          </button>
                        ))
                      : null}
                    {!releaseStage ? (
                      <>
                        <button
                          type="button"
                          disabled={busy || !canDecide || !stageReviewReady}
                          className="task-detail-workspace-ghost-action"
                          data-testid={`todo-workflow-approve-${node.id}`}
                          onClick={() =>
                            void run({
                              type: "decide_node",
                              node_id: node.id,
                              action: "approve",
                              idempotency_key: requestKey([node.id, "approve"]),
                            }).catch(() => undefined)
                          }
                        >
                          {translate("todo.workflow_approve", "批准并推进")}
                        </button>
                        <button
                          type="button"
                          disabled={busy || !canDecide}
                          className="task-detail-workspace-ghost-action"
                          data-testid={`todo-workflow-reject-${node.id}`}
                          onClick={() =>
                            openOperation({
                              type: "decide_node",
                              node,
                              action: "reject",
                            })
                          }
                        >
                          {translate("todo.workflow_reject", "要求返工")}
                        </button>
                      </>
                    ) : canManage && editable ? (
                      <button
                        type="button"
                        disabled={busy || !canDecide}
                        className="task-detail-workspace-ghost-action"
                        data-testid={`issue-workflow-release-open-${node.id}`}
                        onClick={() => {
                          setReleaseNodeId(node.id);
                          setError(null);
                        }}
                      >
                        {translate(
                          "todo.strategy_release_open",
                          "登记发布记录",
                        )}
                      </button>
                    ) : null}
                    {snapshot && active ? (
                      <>
                        {node.status === "waiting" ||
                        node.status === "blocked" ? (
                          <button
                            type="button"
                            disabled={busy}
                            className="task-detail-workspace-ghost-action"
                            data-testid={`issue-strategy-resume-${node.id}`}
                            onClick={() =>
                              openOperation({
                                type: "set_stage_state",
                                node,
                                state: "ready",
                              })
                            }
                          >
                            {translate("todo.strategy_resume", "恢复处理")}
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              className="task-detail-workspace-ghost-action"
                              data-testid={`issue-strategy-wait-${node.id}`}
                              onClick={() =>
                                openOperation({
                                  type: "set_stage_state",
                                  node,
                                  state: "waiting",
                                })
                              }
                            >
                              {translate("todo.strategy_wait", "标记等待")}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              className="task-detail-workspace-ghost-action"
                              data-testid={`issue-strategy-block-${node.id}`}
                              onClick={() =>
                                openOperation({
                                  type: "set_stage_state",
                                  node,
                                  state: "blocked",
                                })
                              }
                            >
                              {translate("todo.strategy_block", "记录阻塞")}
                            </button>
                          </>
                        )}
                      </>
                    ) : null}
                    {canManage ? (
                      <button
                        type="button"
                        disabled={busy}
                        className="task-detail-workspace-ghost-action"
                        data-testid={`todo-workflow-force-${node.id}`}
                        onClick={() =>
                          openOperation({
                            type: "decide_node",
                            node,
                            action: "force_advance",
                          })
                        }
                      >
                        {translate("todo.workflow_force_advance", "强制推进")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {evidenceNodeId === node.id &&
                deliveries?.submitWorkflowEvidence ? (
                  <WorkflowDeliverablesForm
                    key={`${node.id}-${node.attempts}`}
                    node={node}
                    translate={translate}
                    onCancel={() => setEvidenceNodeId(null)}
                    onSubmit={async (fulfillments, files) => {
                      await deliveries.submitWorkflowEvidence!(
                        issue.id,
                        node.id,
                        fulfillments,
                        files,
                      );
                      setEvidenceNodeId(null);
                      await onEvidenceSubmitted?.();
                    }}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {reviewOperation ? (
        <IssueWorkflowReviewForm
          busy={busy}
          decision={reviewOperation.decision}
          roles={reviewRolesFor(reviewOperation.node)}
          role={reviewRole}
          comment={reviewComment}
          evidence={reviewEvidence}
          translate={translate}
          onRoleChange={setReviewRole}
          onCommentChange={setReviewComment}
          onEvidenceChange={setReviewEvidence}
          onSubmit={() => void submitReview()}
          onCancel={() => setReviewOperation(null)}
        />
      ) : null}
      {releaseNodeId ? (
        <IssueWorkflowReleaseForm
          busy={busy}
          translate={translate}
          onSubmit={async (release) => {
            await run({
              type: "record_release",
              release,
              idempotency_key: requestKey(["release", release]),
            });
            setReleaseNodeId(null);
          }}
          onCancel={() => setReleaseNodeId(null)}
        />
      ) : null}
      {operation ? (
        <form
          className="space-y-2 py-3 text-sm"
          data-testid="issue-strategy-reason-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitOperation().catch(() => undefined);
          }}
        >
          <label className="flex flex-col gap-1">
            {translate("todo.workflow_reason", "操作原因（必填）")}
            <textarea
              required
              disabled={busy}
              maxLength={2000}
              value={reason}
              className="min-h-20 rounded-md border border-border bg-background p-2 text-text-primary"
              data-testid="todo-workflow-reason"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {operation.type === "decide_node" &&
          operation.action === "reject" &&
          operation.node.id === "quality_acceptance" ? (
            <label className="flex flex-col gap-1">
              {translate("todo.strategy_rework_target", "退回到")}
              <select
                value={reworkTo}
                disabled={busy}
                data-testid="issue-strategy-rework-target"
                className="min-h-11 rounded-md border border-border bg-background px-2 text-text-primary md:min-h-8"
                onChange={(event) =>
                  setReworkTo(event.target.value as typeof reworkTo)
                }
              >
                <option value="development_preparation">
                  {label("development_preparation")}
                </option>
                <option value="development_implementation">
                  {label("development_implementation")}
                </option>
              </select>
            </label>
          ) : null}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !reason.trim()}
              className="task-detail-workspace-ghost-action"
              data-testid="todo-workflow-confirm"
            >
              {translate("todo.workflow_confirm", "确认操作")}
            </button>
            <button
              type="button"
              disabled={busy}
              className="task-detail-workspace-ghost-action"
              data-testid="todo-workflow-cancel"
              onClick={() => setOperation(null)}
            >
              {translate("cancel", "取消")}
            </button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="py-2 text-sm text-error"
          data-testid="todo-workflow-error"
        >
          {error}
        </p>
      ) : null}
      <IssueWorkflowAuditRecords
        workflow={workflow}
        members={members}
        translate={translate}
        label={label}
      />
    </section>
  );
}
