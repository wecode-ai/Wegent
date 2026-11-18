// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  IssueWorkflowInstance,
  WorkflowStageReview,
} from "../automation/types";
import type { CollaborationTranslate } from "../i18n";
import type { CollaborationMember } from "../types";

export function IssueWorkflowReviewSummary({
  workflow,
  members,
  reviews,
  translate,
}: {
  workflow?: IssueWorkflowInstance | null;
  members: CollaborationMember[];
  reviews: WorkflowStageReview[];
  translate: CollaborationTranslate;
}) {
  const pullRequests = Object.entries(
    workflow?.change_request_state?.pull_requests ?? {},
  );
  return (
    <>
      {workflow?.current_stage_id && reviews.length ? (
        <section
          className="space-y-2 py-3 text-sm"
          data-testid="issue-strategy-reviews"
        >
          <h4 className="font-medium text-text-primary">
            {translate("todo.strategy_review_latest", "阶段评审结论")}
          </h4>
          {reviews.map((review) => (
            <div
              key={review.idempotency_key}
              className="rounded-md border border-border/50 p-2"
              data-testid={`issue-strategy-review-${review.function_role}`}
            >
              <p className="font-medium text-text-primary">
                {review.function_role} ·{" "}
                {translate(
                  `todo.strategy_review_decision_${review.decision}`,
                  review.decision,
                )}
              </p>
              <p className="text-text-secondary">
                {members.find((member) => member.user_id === review.reviewer_id)
                  ?.user_name ??
                  translate("todo.strategy_authorized_member", "授权成员")}{" "}
                · <time dateTime={review.created_at}>{review.created_at}</time>
              </p>
              {review.comment ? <p>{review.comment}</p> : null}
            </div>
          ))}
        </section>
      ) : null}
      {pullRequests.length ? (
        <section
          className="space-y-2 py-3 text-sm"
          data-testid="issue-strategy-pull-requests"
        >
          <h4 className="font-medium text-text-primary">
            {translate("todo.strategy_pull_requests", "关联 PR")}
          </h4>
          {pullRequests.map(([id, pullRequest]) => (
            <div key={id} className="rounded-md border border-border/50 p-2">
              <p className="font-medium text-text-primary">
                {pullRequest.url ? (
                  <a href={pullRequest.url} target="_blank" rel="noreferrer">
                    {pullRequest.repository ?? id}#{pullRequest.number ?? ""}
                  </a>
                ) : (
                  id
                )}
              </p>
              <p className="break-all text-text-secondary">
                {translate("todo.strategy_pr_head", "Head")}：
                {pullRequest.head_sha ?? "—"}
              </p>
              <p className="text-text-secondary">
                {translate("todo.strategy_pr_checks", "Checks")}：
                {pullRequest.checks_summary ?? "—"} ·{" "}
                {translate("todo.strategy_pr_mergeable", "Mergeable")}：
                {pullRequest.mergeable ?? "—"} ·{" "}
                {translate("todo.strategy_pr_state", "状态")}：
                {pullRequest.state ?? "—"}
              </p>
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}

export function IssueWorkflowAuditRecords({
  workflow,
  members,
  translate,
  label,
}: {
  workflow?: IssueWorkflowInstance | null;
  members: CollaborationMember[];
  translate: CollaborationTranslate;
  label(id: string | null | undefined): string;
}) {
  return (
    <>
      {workflow?.release_records?.length ? (
        <section
          className="space-y-2 py-2 text-xs text-text-secondary"
          data-testid="issue-strategy-release-records"
        >
          <h4>{translate("todo.strategy_release_records", "发布记录")}</h4>
          {workflow.release_records.map((record, index) => (
            <p key={`${record.version}-${record.released_at}-${index}`}>
              {record.version} · {record.environment} ·{" "}
              {record.successful
                ? translate("todo.strategy_release_successful", "发布成功")
                : translate("todo.strategy_release_failed", "发布失败")}{" "}
              · <time dateTime={record.released_at}>{record.released_at}</time>
              {record.url ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={record.url} target="_blank" rel="noreferrer">
                    URL
                  </a>
                </>
              ) : null}
            </p>
          ))}
        </section>
      ) : null}
      {workflow?.status_stage_repairs?.length ? (
        <details
          className="py-2 text-xs text-text-secondary"
          data-testid="issue-strategy-repairs"
        >
          <summary className="cursor-pointer">
            {translate("todo.strategy_state_repairs", "状态与阶段修复记录")}
          </summary>
          {workflow.status_stage_repairs.map((repair, index) => (
            <p key={`${repair.at}-${index}`}>
              {repair.from_status}/{repair.from_stage ?? "inbox"} →{" "}
              {repair.to_status}/{repair.to_stage ?? "inbox"} · {repair.source}{" "}
              · <time dateTime={repair.at}>{repair.at}</time>
            </p>
          ))}
        </details>
      ) : null}
      {workflow?.strategy_upgrade_history?.length ? (
        <div
          className="space-y-1 py-2 text-xs text-text-secondary"
          data-testid="issue-strategy-upgrade-history"
        >
          <h4>{translate("todo.strategy_upgrade_history", "策略升级记录")}</h4>
          {workflow.strategy_upgrade_history.map((entry, index) => (
            <p key={index}>
              {translate(
                "todo.strategy_upgrade_record",
                "v{{from}} → v{{to}} · {{reason}}",
                {
                  from: entry.from_version,
                  to: entry.to_version,
                  reason: entry.reason,
                },
              )}{" "}
              · <time dateTime={entry.upgraded_at}>{entry.upgraded_at}</time>
            </p>
          ))}
        </div>
      ) : null}
      {workflow?.nodes.some((node) => node.decision_history?.length) ? (
        <ol
          className="space-y-1 py-2 text-xs text-text-secondary"
          data-testid="todo-workflow-audit"
        >
          {workflow.nodes.flatMap((node) =>
            (node.decision_history ?? []).map((entry, index) => (
              <li key={`${node.id}-${entry.decided_at}-${index}`}>
                {label(node.id)} ·{" "}
                {translate(`todo.workflow_action_${entry.action}`, "阶段决定")}{" "}
                ·{" "}
                {members.find(
                  (member) => member.user_id === entry.actor_user_id,
                )?.user_name ??
                  translate("todo.strategy_authorized_member", "授权成员")}{" "}
                ·{" "}
                {translate(
                  `todo.workflow_source_${entry.source ?? "human"}`,
                  "人工确认",
                )}{" "}
                · <time dateTime={entry.decided_at}>{entry.decided_at}</time>
                {entry.reason ? ` · ${entry.reason}` : ""}
              </li>
            )),
          )}
        </ol>
      ) : null}
    </>
  );
}
