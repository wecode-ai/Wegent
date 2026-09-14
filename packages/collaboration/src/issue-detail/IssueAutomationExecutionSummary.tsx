// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Check, Circle, LoaderCircle } from "lucide-react";
import { useRuntimeConfiguration } from "../runtime-profile/context";
import type { WorkspaceRuntimeProfile } from "../ports/SharedWorkspaceApi";
import type { CollaborationIssue } from "../types";
import { executionStatusLabel } from "./executionStatusLabel";
import { ExecutionConfigurationNotice } from "../runtime-profile/ExecutionConfigurationNotice";

import type {
  SharedIssueDetailAgent,
  SharedIssueDetailWorkflowPlan,
} from "./createSharedIssueDetailPort";
import type { SharedWorkflowNode, WorkflowNodeStatus } from "./workflowTypes";
import {
  coordinatorConfigurationMissing,
  type WorkflowCoordinatorConfiguration,
} from "./workflowConfiguration";

type Translate = (
  key: string,
  fallback?: string,
  options?: Record<string, string | number>,
) => string;

const completedStatuses = new Set<WorkflowNodeStatus>([
  "completed",
  "forced_completed",
]);

function stageStatusLabel(status: WorkflowNodeStatus, translate: Translate) {
  if (completedStatuses.has(status))
    return translate("todo.workflow_stage_completed", "已完成");
  if (status === "running" || status === "reacting")
    return translate("todo.workflow_stage_running", "执行中");
  if (status === "queued" || status === "ready")
    return translate("todo.workflow_stage_queued", "准备执行");
  if (status === "awaiting_approval")
    return translate("todo.workflow_stage_awaiting_approval", "等待确认");
  if (status === "awaiting_deliverables")
    return translate("todo.workflow_stage_awaiting_deliverables", "等待交付物");
  if (status === "changes_requested")
    return translate("todo.workflow_stage_changes_requested", "需要修改");
  if (status === "failed")
    return translate("todo.workflow_stage_failed", "执行失败");
  return translate("todo.workflow_stage_waiting", "等待前序阶段");
}

function stageAgentName(
  node: SharedWorkflowNode,
  agents: SharedIssueDetailAgent[],
) {
  if (node.required_assignee_type !== "agent" || !node.required_assignee_id)
    return null;
  return (
    agents.find((agent) => agent.id === node.required_assignee_id)?.name ??
    node.required_assignee_name ??
    null
  );
}

function stageWaitingReason(
  node: SharedWorkflowNode,
  nodes: SharedWorkflowNode[],
  translate: Translate,
) {
  if (node.status !== "blocked" && node.status !== "waiting") return null;
  const dependencies = node.depends_on
    .map((dependencyId) =>
      nodes.find((candidate) => candidate.id === dependencyId),
    )
    .filter((dependency): dependency is SharedWorkflowNode =>
      Boolean(dependency),
    )
    .map((dependency) => dependency.name);
  if (dependencies.length === 0)
    return translate("todo.workflow_stage_waiting", "等待前序阶段");
  return translate(
    "todo.workflow_stage_waiting_for",
    `等待 ${dependencies.join("、")} 完成`,
    { stages: dependencies.join("、") },
  );
}

function StageIcon({ status }: { status: WorkflowNodeStatus }) {
  if (completedStatuses.has(status))
    return <Check aria-hidden="true" className="h-3.5 w-3.5" />;
  if (status === "running" || status === "reacting")
    return (
      <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
    );
  return <Circle aria-hidden="true" className="h-3.5 w-3.5" />;
}

function childExecutionLabel(
  children: CollaborationIssue[],
  translate: Translate,
) {
  if (!children.length) return null;
  if (children.some((child) => child.execution_state === "waiting_runtime"))
    return translate(
      "todo.workflow_children_waiting_runtime",
      "子任务等待设备或模型配置",
    );
  for (const state of [
    "failed",
    "running",
    "starting",
    "waiting_device",
    "waiting_approval",
    "queued",
  ]) {
    if (children.some((child) => child.execution_state === state))
      return executionStatusLabel(state, translate);
  }
  if (
    children.every(
      (child) =>
        child.execution_state === "succeeded" || child.status === "completed",
    )
  )
    return translate(
      "todo.workflow_children_review",
      "子任务执行已结束，等待验收",
    );
  return translate("todo.workflow_children_pending", "已分派，等待子任务执行");
}

export function IssueAutomationExecutionSummary({
  nodes,
  workflow,
  plan,
  childIssues = [],
  onOpenChild,
  onConfigured,
  agents,
  location,
  issueCompleted,
  translate,
}: {
  nodes: SharedWorkflowNode[];
  workflow?: WorkflowCoordinatorConfiguration | null;
  plan?: Pick<SharedIssueDetailWorkflowPlan, "stage_id" | "items"> | null;
  childIssues?: CollaborationIssue[];
  onOpenChild?(child: CollaborationIssue): void;
  onConfigured?(profile: WorkspaceRuntimeProfile): Promise<void>;
  agents: SharedIssueDetailAgent[];
  location: "local" | "cloud";
  issueCompleted: boolean;
  translate: Translate;
}) {
  const configureRuntime = useRuntimeConfiguration();
  const stages = nodes.filter(
    (node) => !node.node_type || node.node_type === "task",
  );
  if (stages.length === 0) return null;
  const needsConfiguration =
    !issueCompleted && coordinatorConfigurationMissing(workflow);

  const completedCount = stages.filter((stage) =>
    completedStatuses.has(stage.status),
  ).length;
  const executionLocation =
    location === "local"
      ? translate("todo.workflow_local_space", "本地空间")
      : translate("todo.workflow_cloud_space", "云端空间");
  const activeStage = stages.find((stage) =>
    ["ready", "queued", "reacting", "running"].includes(stage.status),
  );
  const nextBlockedStage = stages.find(
    (stage) => stage.status === "blocked" || stage.status === "waiting",
  );

  return (
    <section
      className="issue-automation-execution"
      data-testid="collaboration-automation-execution"
    >
      <header className="issue-automation-execution-head">
        <div>
          <strong>
            {translate("todo.automation_execution", "自动化执行")}
          </strong>
          <span data-testid="collaboration-automation-rule-chain">
            {stages.map((stage) => stage.name).join(" → ")}
          </span>
        </div>
        <span data-testid="collaboration-automation-progress">
          {completedCount} / {stages.length}
        </span>
      </header>

      {needsConfiguration ? (
        <p role="alert" data-testid="collaboration-automation-missing-config">
          {translate(
            "runtimeSettings.workflowMissing",
            "AI 调度器缺少设备或模型配置，任务尚未启动。请前往「项目设置 → 分配与调度 → 我的默认执行配置」完成配置。",
          )}
          {configureRuntime ? (
            <button
              type="button"
              className="collaboration-secondary-button ml-2 min-h-11"
              data-testid="issue-configure-runtime"
              onClick={() => configureRuntime(onConfigured)}
            >
              {translate("runtimeSettings.configure", "立即配置")}
            </button>
          ) : null}
        </p>
      ) : null}
      <div className="issue-automation-stage-list">
        {stages.map((stage, index) => {
          const waitingReason = stageWaitingReason(stage, stages, translate);
          const agentName = stageAgentName(stage, agents);
          const taskIds =
            plan?.stage_id === stage.id
              ? new Set(
                  plan.items.map(
                    (item) => (item as { task_id?: string }).task_id,
                  ),
                )
              : new Set<string>();
          const children = childIssues.filter((child) => taskIds.has(child.id));
          const childLabel =
            completedStatuses.has(stage.status) || stage.status === "failed"
              ? null
              : childExecutionLabel(children, translate);
          return (
            <article
              className={`issue-automation-stage is-${stage.status}`}
              data-status={stage.status}
              data-testid={`collaboration-automation-stage-${index}`}
              key={stage.id}
            >
              <span className="issue-automation-stage-icon">
                <StageIcon status={stage.status} />
              </span>
              <div>
                <strong>{stage.name}</strong>
                <p>
                  {(childLabel ? null : waitingReason) ??
                    [
                      childLabel ??
                        (needsConfiguration &&
                        ["ready", "queued"].includes(stage.status)
                          ? translate("runtimeSettings.waiting", "等待配置")
                          : stageStatusLabel(stage.status, translate)),
                      agentName,
                      executionLocation,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                </p>
                {children.map((child) => (
                  <ExecutionConfigurationNotice
                    key={child.id}
                    issue={child}
                    translate={translate}
                  />
                ))}
                {onOpenChild
                  ? children.map((child) => (
                      <button
                        key={child.id}
                        type="button"
                        className="collaboration-secondary-button mt-2 min-h-11"
                        data-testid={`automation-open-child-${child.id}`}
                        onClick={() => onOpenChild(child)}
                      >
                        {translate("todo.view_child_task", "查看子任务")} ·{" "}
                        {child.title}
                      </button>
                    ))
                  : null}
              </div>
            </article>
          );
        })}
      </div>

      <p className="issue-automation-execution-foot">
        {issueCompleted || completedCount === stages.length
          ? translate(
              "todo.workflow_all_stages_completed",
              "所有自动化阶段已完成，Issue 已自动完成",
            )
          : nextBlockedStage && activeStage
            ? translate(
                "todo.workflow_next_stage_unlocks",
                `${activeStage.name} 完成后将自动进入 ${nextBlockedStage.name}`,
                {
                  current: activeStage.name,
                  next: nextBlockedStage.name,
                },
              )
            : translate(
                "todo.workflow_driven_by_rule",
                "此 Issue 由自动化规则按顺序推进",
              )}
      </p>
    </section>
  );
}
