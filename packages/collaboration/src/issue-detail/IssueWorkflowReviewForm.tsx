// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  WorkflowStageReviewDecisionKind,
  WorkflowStageReviewRole,
} from "../automation/types";
import type { CollaborationTranslate } from "../i18n";

export function IssueWorkflowReviewForm({
  busy,
  decision,
  roles,
  role,
  comment,
  evidence,
  translate,
  onRoleChange,
  onCommentChange,
  onEvidenceChange,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  decision: WorkflowStageReviewDecisionKind;
  roles: WorkflowStageReviewRole[];
  role: WorkflowStageReviewRole | "";
  comment: string;
  evidence: string;
  translate: CollaborationTranslate;
  onRoleChange(role: WorkflowStageReviewRole): void;
  onCommentChange(value: string): void;
  onEvidenceChange(value: string): void;
  onSubmit(): void;
  onCancel(): void;
}) {
  return (
    <form
      className="space-y-3 py-3 text-sm"
      data-testid="issue-strategy-review-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h4 className="font-medium text-text-primary">
        {translate(`todo.strategy_review_${decision}`, decision)}
      </h4>
      {roles.length > 1 ? (
        <label className="flex flex-col gap-1">
          {translate("todo.strategy_review_role", "评审职能")}
          <select
            value={role}
            disabled={busy}
            data-testid="issue-strategy-review-role"
            className="min-h-11 rounded-md border border-border bg-background px-2 text-text-primary md:min-h-8"
            onChange={(event) =>
              onRoleChange(event.target.value as WorkflowStageReviewRole)
            }
          >
            {roles.map((option) => (
              <option key={option} value={option}>
                {translate(`todo.strategy_review_role_${option}`, option)}
              </option>
            ))}
          </select>
        </label>
      ) : role ? (
        <p className="text-text-secondary">
          {translate("todo.strategy_review_role", "评审职能")}：
          {translate(`todo.strategy_review_role_${role}`, role)}
        </p>
      ) : null}
      <label className="flex flex-col gap-1">
        {translate("todo.strategy_review_comment", "评审意见")}
        <textarea
          value={comment}
          disabled={busy}
          maxLength={4000}
          data-testid="issue-strategy-review-comment"
          className="min-h-20 rounded-md border border-border bg-background p-2 text-text-primary"
          onChange={(event) => onCommentChange(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        {translate("todo.strategy_review_evidence_refs", "证据引用")}
        <textarea
          value={evidence}
          disabled={busy}
          data-testid="issue-strategy-review-evidence"
          placeholder="delivery:… / comment:… / PR URL"
          className="min-h-16 rounded-md border border-border bg-background p-2 text-text-primary"
          onChange={(event) => onEvidenceChange(event.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={
            busy || !role || (decision !== "no_objection" && !comment.trim())
          }
          className="task-detail-workspace-ghost-action"
          data-testid="issue-strategy-review-submit"
        >
          {translate("todo.strategy_review_submit", "提交评审结论")}
        </button>
        <button
          type="button"
          disabled={busy}
          className="task-detail-workspace-ghost-action"
          data-testid="issue-strategy-review-cancel"
          onClick={onCancel}
        >
          {translate("cancel", "取消")}
        </button>
      </div>
    </form>
  );
}
