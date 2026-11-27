// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ArrowRight } from "lucide-react";
import { formatIssueTimestamp } from "./issueTimestamp";
import type { ComponentProps } from "react";
import {
  localizeStandardStatusName,
  type CollaborationTranslate,
} from "../i18n";

import type {
  SharedIssueAssignmentHistoryEntry,
  SharedIssueStatusHistoryEntry,
} from "../types";

export type IssueAssignmentHistoryEntry = SharedIssueAssignmentHistoryEntry;
export type IssueStatusHistoryEntry = SharedIssueStatusHistoryEntry;

export function assignmentHistoryLabels(
  t: (key: string, fallback: string) => string,
) {
  return {
    system: t("todo.status_history_system", "系统/机器人"),
    team: t("todo.assignment_chain_team", "Wegent 智能体"),
    agent: t("todo.assignment_chain_agent", "机器人"),
    group: t("todo.assignment_chain_group", "协作小组"),
    unassigned: t("todo.assignment_chain_unassigned", "未指派"),
    actions: {
      assign: t("todo.assignment_action_assign", "指派"),
      reassign: t("todo.assignment_action_reassign", "转派"),
      redeliver: t("todo.assignment_action_redeliver", "重新投递"),
      unassign: t("todo.assignment_action_unassign", "取消指派"),
    },
  };
}

export function IssueStatusActivity({
  entry,
  index,
  labels,
  memberName,
}: Pick<
  ComponentProps<typeof IssueStatusHistoryList>,
  "labels" | "memberName"
> & {
  entry: IssueStatusHistoryEntry;
  index: number;
}) {
  return (
    <div
      data-testid={`cloud-task-status-event-${index}`}
      className="task-detail-timeline-system-event"
    >
      <span className="task-detail-timeline-marker" aria-hidden="true" />
      <div className="task-detail-timeline-system-content">
        <IssueStatusHistoryList
          entries={[entry]}
          startIndex={index}
          labels={labels}
          memberName={memberName}
        />
      </div>
    </div>
  );
}

export function IssueAssignmentHistoryList({
  entries,
  memberName,
  labels,
}: {
  entries: IssueAssignmentHistoryEntry[];
  memberName(userId: number | null): string | null;
  labels: {
    team: string;
    agent: string;
    group: string;
    system?: string;
    unassigned: string;
    actions: Record<IssueAssignmentHistoryEntry["action"] | "redeliver", string>;
  };
}) {
  return entries.map((entry, index) => {
    const byName =
      entry.by_agent_name ??
      entry.automation?.rule_name ??
      memberName(entry.by_user_id) ??
      (entry.by_user_id === 0 ? labels.system : null);
    const isUnassign = entry.action === "unassign";
    const toName = isUnassign
      ? labels.unassigned
      : entry.to_type === "agent" ||
          entry.to_type === "team" ||
          entry.to_type === "group"
        ? (entry.to_name ??
          (entry.to_type === "team"
            ? labels.team
            : entry.to_type === "group"
              ? labels.group
              : labels.agent))
        : (entry.to_name ?? memberName(Number(entry.to_id)));
    return (
      <div key={`${entry.at}-${index}`} className="rounded-md px-1.5 py-1.5">
        <div className="issue-assignment-history-route flex items-center gap-1.5 text-xs text-text-primary">
          <span className="truncate font-medium">
            {byName ?? `#${entry.by_user_id}`}
          </span>
          {!isUnassign && (
            <ArrowRight className="h-3 w-3 shrink-0 text-text-muted" />
          )}
          <span className="truncate">{toName ?? labels.unassigned}</span>
        </div>
        <p className="mt-0.5 text-xs text-text-secondary">
          {labels.actions[entry.redeliver ? "redeliver" : entry.action]} ·{" "}
          {formatIssueTimestamp(entry.at)}
        </p>
      </div>
    );
  });
}

export function IssueStatusHistoryList({
  entries,
  memberName,
  labels,
  startIndex = 0,
}: {
  entries: IssueStatusHistoryEntry[];
  memberName(userId: number | null): string | null;
  startIndex?: number;
  labels: {
    system: string;
    unset: string;
    initial: string;
    accept: string;
    statusName(id: string, name: string | null | undefined): string;
    action(trigger: string): string;
  };
}) {
  return entries.map((entry, index) => {
    const actor =
      entry.automation?.rule_name ??
      memberName(entry.by_user_id) ??
      labels.system;
    const toName =
      labels.statusName(entry.to_status, entry.to_status_name) || labels.unset;
    const isCreate = entry.trigger === "create";
    const isAccept =
      entry.trigger === "user_update" &&
      entry.from_status === "in_review" &&
      entry.to_status === "completed";
    return (
      <div
        key={`${entry.at}-${index}`}
        className="rounded-md px-1.5 py-1.5"
        data-testid={`cloud-todo-status-history-entry-${startIndex + index}`}
      >
        <div className="flex items-center gap-1.5 text-xs text-text-primary">
          <span className="shrink-0 font-medium">{actor}</span>
          {isCreate ? (
            <>
              <span className="shrink-0 text-text-secondary">
                {labels.initial}
              </span>
              <span className="min-w-0 truncate">{toName}</span>
            </>
          ) : (
            <>
              <span className="min-w-0 truncate">
                {labels.statusName(entry.from_status, entry.from_status_name) ||
                  labels.unset}
              </span>
              <ArrowRight className="h-3 w-3 shrink-0 text-text-muted" />
              <span className="min-w-0 truncate">{toName}</span>
            </>
          )}
        </div>
        <p className="mt-0.5 text-xs text-text-secondary">
          {isAccept ? labels.accept : labels.action(entry.trigger)} ·{" "}
          {formatIssueTimestamp(entry.at)}
        </p>
      </div>
    );
  });
}

const STATUS_ACTION_KEYS: Record<string, string> = {
  create: "todo.status_action_create",
  user_update: "todo.status_action_user_update",
  ai_started: "todo.status_action_ai_started",
  ai_completed: "todo.status_action_ai_completed",
  task_started: "todo.status_action_task_started",
  delivery: "todo.status_action_delivery",
  status_removed: "todo.status_action_status_removed",
  workflow_plan_approved: "todo.status_action_workflow_plan_approved",
  workflow_task_progress: "todo.status_action_workflow_task_progress",
  workflow_outcome_passed: "todo.status_action_workflow_outcome_passed",
  workflow_outcome_needs_rework:
    "todo.status_action_workflow_outcome_needs_rework",
  workflow_manager_review: "todo.status_action_workflow_manager_review",
  workflow_manager_completed: "todo.status_action_workflow_manager_completed",
  workflow_review_approved: "todo.status_action_workflow_review_approved",
  workflow_stage_advanced: "todo.status_action_workflow_stage_advanced",
  workflow_replanned: "todo.status_action_workflow_replanned",
  workflow_paused: "todo.status_action_workflow_paused",
  workflow_resumed: "todo.status_action_workflow_resumed",
  reassignment: "todo.status_action_reassignment",
  unassigned: "todo.status_action_unassigned",
  local_status_change: "todo.status_action_local_status_change",
};

export function issueStatusHistoryLabels(t: CollaborationTranslate) {
  return {
    system: t("todo.status_history_system", "系统/机器人"),
    unset: t("todo.status_history_unset", "未设置"),
    initial: t("todo.status_history_initial", "初始状态"),
    accept: t("todo.status_action_accept", "验收"),
    statusName: (id: string, name: string | null | undefined) =>
      localizeStandardStatusName(id, name, t),
    action: (trigger: string) =>
      t(
        STATUS_ACTION_KEYS[trigger] ?? "todo.status_action_user_update",
        trigger,
      ),
  };
}
