// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Check, Circle, LoaderCircle } from "lucide-react";

import type { SharedIssueDetailAgent } from "./createSharedIssueDetailPort";
import type { SharedWorkflowNode, WorkflowNodeStatus } from "./workflowTypes";

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

export function IssueAutomationExecutionSummary({
  nodes,
  agents,
  location,
  issueCompleted,
  translate,
}: {
  nodes: SharedWorkflowNode[];
  agents: SharedIssueDetailAgent[];
  location: "local" | "cloud";
  issueCompleted: boolean;
  translate: Translate;
}) {
  const stages = nodes.filter(
    (node) => !node.node_type || node.node_type === "task",
  );
  if (stages.length === 0) return null;

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

      <div className="issue-automation-stage-list">
        {stages.map((stage, index) => {
          const waitingReason = stageWaitingReason(stage, stages, translate);
          const agentName = stageAgentName(stage, agents);
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
                  {waitingReason ??
                    [
                      stageStatusLabel(stage.status, translate),
                      agentName,
                      executionLocation,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                </p>
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
