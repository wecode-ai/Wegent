// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import type { WorkflowReleaseRecord } from "../automation/types";
import type { CollaborationTranslate } from "../i18n";

type ReleaseInput = Omit<
  WorkflowReleaseRecord,
  "recorded_by_user_id" | "recorded_at" | "idempotency_key" | "pull_request_ids"
>;

type ReleaseForm = {
  version: string;
  url: string;
  releasedAt: string;
  environment: string;
  mergeCommits: string;
  onlineVerification: string;
  rollbackSummary: string;
  retrospective: string;
  successful: boolean;
};

const emptyReleaseForm = (): ReleaseForm => ({
  version: "",
  url: "",
  releasedAt: new Date().toISOString().slice(0, 16),
  environment: "production",
  mergeCommits: "",
  onlineVerification: "",
  rollbackSummary: "",
  retrospective: "",
  successful: true,
});

export function IssueWorkflowReleaseForm({
  busy,
  translate,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  translate: CollaborationTranslate;
  onSubmit(release: ReleaseInput): Promise<void>;
  onCancel(): void;
}) {
  const [form, setForm] = useState<ReleaseForm>(emptyReleaseForm);
  const valid =
    Boolean(form.version.trim()) &&
    Boolean(form.url.trim()) &&
    Boolean(form.environment.trim()) &&
    Number.isFinite(new Date(form.releasedAt).getTime()) &&
    (!form.successful ||
      (Boolean(form.mergeCommits.trim()) &&
        Boolean(form.onlineVerification.trim()) &&
        Boolean(form.rollbackSummary.trim()) &&
        Boolean(form.retrospective.trim())));

  const submit = async () => {
    if (!valid) return;
    try {
      await onSubmit({
        version: form.version.trim(),
        url: form.url.trim(),
        released_at: new Date(form.releasedAt).toISOString(),
        environment: form.environment.trim(),
        merge_commits: form.mergeCommits
          .split(/[\n,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
        online_verification: form.onlineVerification.trim(),
        rollback_summary: form.rollbackSummary.trim(),
        retrospective: form.retrospective.trim(),
        successful: form.successful,
      });
    } catch {
      // The panel renders the submission error and keeps the form open.
    }
  };

  return (
    <form
      className="space-y-3 py-3 text-sm"
      data-testid="issue-workflow-release-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h4 className="font-medium text-text-primary">
        {translate("todo.strategy_release_title", "登记成功发布")}
      </h4>
      {(
        [
          ["version", "todo.strategy_release_version", "发布版本或 tag"],
          ["url", "todo.strategy_release_url", "发布 URL"],
          ["environment", "todo.strategy_release_environment", "目标环境"],
        ] as const
      ).map(([field, key, fallback]) => (
        <label className="flex flex-col gap-1" key={field}>
          {translate(key, fallback)}
          <input
            value={form[field]}
            disabled={busy}
            data-testid={`issue-workflow-release-${field}`}
            className="min-h-11 rounded-md border border-border bg-background px-2 text-text-primary md:min-h-8"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                [field]: event.target.value,
              }))
            }
          />
        </label>
      ))}
      <label className="flex flex-col gap-1">
        {translate("todo.strategy_release_time", "发布时间")}
        <input
          type="datetime-local"
          value={form.releasedAt}
          disabled={busy}
          data-testid="issue-workflow-release-releasedAt"
          className="min-h-11 rounded-md border border-border bg-background px-2 text-text-primary md:min-h-8"
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              releasedAt: event.target.value,
            }))
          }
        />
      </label>
      {(
        [
          [
            "mergeCommits",
            "todo.strategy_release_commits",
            "Merge commits（逗号或换行分隔）",
          ],
          [
            "onlineVerification",
            "todo.strategy_release_verification",
            "线上验证结论",
          ],
          ["rollbackSummary", "todo.strategy_release_rollback", "回滚准备"],
          ["retrospective", "todo.strategy_release_retrospective", "复盘结论"],
        ] as const
      ).map(([field, key, fallback]) => (
        <label className="flex flex-col gap-1" key={field}>
          {translate(key, fallback)}
          <textarea
            value={form[field]}
            disabled={busy}
            data-testid={`issue-workflow-release-${field}`}
            className="min-h-16 rounded-md border border-border bg-background p-2 text-text-primary"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                [field]: event.target.value,
              }))
            }
          />
        </label>
      ))}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={form.successful}
          disabled={busy}
          data-testid="issue-workflow-release-successful"
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              successful: event.target.checked,
            }))
          }
        />
        {translate("todo.strategy_release_successful", "发布成功")}
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !valid}
          className="task-detail-workspace-ghost-action"
          data-testid="issue-workflow-release-submit"
        >
          {translate("todo.strategy_release_submit", "保存发布记录")}
        </button>
        <button
          type="button"
          disabled={busy}
          className="task-detail-workspace-ghost-action"
          data-testid="issue-workflow-release-cancel"
          onClick={onCancel}
        >
          {translate("cancel", "取消")}
        </button>
      </div>
    </form>
  );
}
