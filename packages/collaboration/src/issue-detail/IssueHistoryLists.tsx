// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ArrowRight } from "lucide-react";

export interface IssueAssignmentHistoryEntry {
  by_user_id: number;
  to_type: "user" | "agent" | "team" | null;
  to_id: string | null;
  to_name?: string | null;
  action: "assign" | "reassign" | "unassign";
  at: string;
}

export interface IssueStatusHistoryEntry {
  from_status: string;
  from_status_name?: string | null;
  to_status: string;
  to_status_name?: string | null;
  trigger: string;
  by_user_id: number | null;
  at: string;
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
    unassigned: string;
    actions: Record<IssueAssignmentHistoryEntry["action"], string>;
  };
}) {
  return entries.map((entry, index) => {
    const byName = memberName(entry.by_user_id);
    const toName =
      entry.to_type === "agent" || entry.to_type === "team"
        ? (entry.to_name ??
          (entry.to_type === "team" ? labels.team : labels.agent))
        : (entry.to_name ?? memberName(Number(entry.to_id)));
    return (
      <div key={`${entry.at}-${index}`} className="rounded-md px-1.5 py-1.5">
        <div className="flex items-center gap-1.5 text-xs text-text-primary">
          <span className="truncate font-medium">
            {byName ?? `#${entry.by_user_id}`}
          </span>
          <ArrowRight className="h-3 w-3 shrink-0 text-text-muted" />
          <span className="truncate">{toName ?? labels.unassigned}</span>
        </div>
        <p className="mt-0.5 text-xs text-text-muted">
          {labels.actions[entry.action]} · {new Date(entry.at).toLocaleString()}
        </p>
      </div>
    );
  });
}

export function IssueStatusHistoryList({
  entries,
  memberName,
  labels,
}: {
  entries: IssueStatusHistoryEntry[];
  memberName(userId: number | null): string | null;
  labels: {
    system: string;
    unset: string;
    initial: string;
    accept: string;
    action(trigger: string): string;
  };
}) {
  return entries.map((entry, index) => {
    const actor = memberName(entry.by_user_id) ?? labels.system;
    const toName = entry.to_status_name || labels.unset;
    const isCreate = entry.trigger === "create";
    const isAccept =
      entry.trigger === "user_update" &&
      entry.from_status === "in_review" &&
      entry.to_status === "completed";
    return (
      <div
        key={`${entry.at}-${index}`}
        className="rounded-md px-1.5 py-1.5"
        data-testid={`cloud-todo-status-history-entry-${index}`}
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
                {entry.from_status_name || labels.unset}
              </span>
              <ArrowRight className="h-3 w-3 shrink-0 text-text-muted" />
              <span className="min-w-0 truncate">{toName}</span>
            </>
          )}
        </div>
        <p className="mt-0.5 text-xs text-text-muted">
          {isAccept ? labels.accept : labels.action(entry.trigger)} ·{" "}
          {new Date(entry.at).toLocaleString()}
        </p>
      </div>
    );
  });
}
