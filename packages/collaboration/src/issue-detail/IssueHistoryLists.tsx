// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ArrowRight } from "lucide-react";
import { formatIssueTimestamp } from "./issueTimestamp";

import type {
  SharedIssueAssignmentHistoryEntry,
  SharedIssueStatusHistoryEntry,
} from "../types";

export type IssueAssignmentHistoryEntry = SharedIssueAssignmentHistoryEntry;
export type IssueStatusHistoryEntry = SharedIssueStatusHistoryEntry;

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
    actions: Record<IssueAssignmentHistoryEntry["action"], string>;
  };
}) {
  return entries.map((entry, index) => {
    const byName =
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
        <p className="mt-0.5 text-xs text-text-muted">
          {labels.actions[entry.action]} · {formatIssueTimestamp(entry.at)}
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
              <span className="shrink-0 text-text-muted">{labels.initial}</span>
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
        <p className="mt-0.5 text-xs text-text-muted">
          {isAccept ? labels.accept : labels.action(entry.trigger)} ·{" "}
          {formatIssueTimestamp(entry.at)}
        </p>
      </div>
    );
  });
}
