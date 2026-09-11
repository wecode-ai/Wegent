// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  SharedIssueDetailDelivery,
  SharedIssueDetailTaskBinding,
} from "./createSharedIssueDetailPort";

export type WorkflowDeliverableValueType =
  | "text"
  | "file"
  | "code_snapshot"
  | "git_branch"
  | "pull_request"
  | "url";

export interface IssueWorkflowDeliverableRequirement {
  id: string;
  name: string;
  description: string;
  value_type: WorkflowDeliverableValueType;
  file_constraints?: {
    accepted_types: string[];
    min_files: number;
    max_files: number;
  } | null;
}

export type WorkflowNodeStatus =
  | "blocked"
  | "ready"
  | "waiting"
  | "reacting"
  | "queued"
  | "running"
  | "awaiting_approval"
  | "awaiting_deliverables"
  | "changes_requested"
  | "completed"
  | "forced_completed"
  | "failed";

export interface SharedWorkflowNode {
  id: string;
  name: string;
  node_type?: "task" | "event" | "loop" | "loop_start" | "branch" | "loop_end";
  loop_id?: string | null;
  body_node_ids?: string[];
  execution_mode?: "human" | "robot";
  depends_on: string[];
  required: boolean;
  required_deliverables?: IssueWorkflowDeliverableRequirement[];
  workspace_policy: "none" | "composer" | "inherit";
  automation_rule_id?: string | null;
  status: WorkflowNodeStatus;
  task_statuses?: Record<string, string>;
  delivery_ids?: string[];
  fulfilled_deliverable_ids?: string[];
  execution_error?: string | null;
  collectors?: Record<
    string,
    {
      collector_id: string;
      mode?: string;
      status?: string;
      error?: string | null;
      created_at?: string;
    }
  >;
}

export type SharedWorkflowTaskBinding = SharedIssueDetailTaskBinding;
export type SharedWorkflowDelivery = SharedIssueDetailDelivery;

export type IssueWorkflowTranslate = (
  key: string,
  fallback?: string | Record<string, string | number>,
  options?: Record<string, string | number>,
) => string;
