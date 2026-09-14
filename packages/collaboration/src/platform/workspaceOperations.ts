// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationIssue, CollaborationProject } from "../types";

export type WorkspaceOperationState =
  | "failed"
  | "review"
  | "running"
  | "pending"
  | "completed";

export interface WorkspaceProjectOperation {
  project: CollaborationProject;
  issues: CollaborationIssue[];
  runningCount: number;
  reviewCount: number;
  failedCount: number;
  pendingCount: number;
  updatedAt: string;
}

const ACTIVE_EXECUTION_STATES = new Set([
  "in_progress",
  "running",
  "streaming",
]);

const PENDING_EXECUTION_STATES = new Set([
  "pending",
  "pending_approval",
  "queued",
  "starting",
  "unknown",
  "waiting_device",
  "waiting_runtime",
]);

export function workspaceIssueOperationState(
  issue: CollaborationIssue,
): WorkspaceOperationState {
  const executionState = issue.execution_state?.toLowerCase() ?? null;
  const workflowFailed =
    issue.workflow?.orchestration_status === "failed" ||
    issue.workflow?.nodes?.some((node) => node.status === "failed") === true;
  if (executionState === "failed" || workflowFailed || issue.execution_error) {
    return "failed";
  }
  if (
    issue.status === "in_review" ||
    executionState === "waiting_approval" ||
    issue.workflow?.orchestration_status === "awaiting_approval" ||
    issue.workflow?.orchestration_status === "awaiting_review"
  ) {
    return "review";
  }
  if (
    issue.status === "in_progress" ||
    (executionState != null && ACTIVE_EXECUTION_STATES.has(executionState)) ||
    issue.workflow?.orchestration_status === "dispatching" ||
    issue.workflow?.orchestration_status === "running"
  ) {
    return "running";
  }
  if (issue.status === "completed") return "completed";
  if (executionState == null || PENDING_EXECUTION_STATES.has(executionState)) {
    return "pending";
  }
  return "pending";
}

export function createWorkspaceOperationsSnapshot({
  projects,
  projectIssues,
}: {
  projects: CollaborationProject[];
  projectIssues: Record<string, CollaborationIssue[]>;
}) {
  const operations = projects
    .map<WorkspaceProjectOperation>((project) => {
      const issues = projectIssues[project.id] ?? [];
      const states = issues.map(workspaceIssueOperationState);
      const updatedAt =
        [...issues]
          .sort((left, right) =>
            right.updated_at.localeCompare(left.updated_at),
          )
          .at(0)?.updated_at ?? project.updated_at;
      return {
        project,
        issues,
        runningCount: states.filter((state) => state === "running").length,
        reviewCount: states.filter((state) => state === "review").length,
        failedCount: states.filter((state) => state === "failed").length,
        pendingCount: states.filter((state) => state === "pending").length,
        updatedAt,
      };
    })
    .sort((left, right) => {
      if (left.failedCount !== right.failedCount) {
        return right.failedCount - left.failedCount;
      }
      if (left.reviewCount !== right.reviewCount) {
        return right.reviewCount - left.reviewCount;
      }
      if (left.runningCount !== right.runningCount) {
        return right.runningCount - left.runningCount;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    });

  const issues = operations.flatMap((operation) =>
    operation.issues.map((issue) => ({ issue, project: operation.project })),
  );
  const attentionItems = issues
    .filter(({ issue }) => {
      const state = workspaceIssueOperationState(issue);
      return state === "failed" || state === "review";
    })
    .sort((left, right) => {
      const leftState = workspaceIssueOperationState(left.issue);
      const rightState = workspaceIssueOperationState(right.issue);
      if (leftState !== rightState) return leftState === "failed" ? -1 : 1;
      return right.issue.updated_at.localeCompare(left.issue.updated_at);
    })
    .slice(0, 6);

  return {
    operations,
    attentionItems,
    totals: {
      projects: projects.length,
      running: issues.filter(
        ({ issue }) => workspaceIssueOperationState(issue) === "running",
      ).length,
      review: issues.filter(
        ({ issue }) => workspaceIssueOperationState(issue) === "review",
      ).length,
      failed: issues.filter(
        ({ issue }) => workspaceIssueOperationState(issue) === "failed",
      ).length,
      pending: issues.filter(
        ({ issue }) => workspaceIssueOperationState(issue) === "pending",
      ).length,
    },
  };
}
