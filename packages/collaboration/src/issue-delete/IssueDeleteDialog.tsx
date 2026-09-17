// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTranslate } from "../i18n";
import { collaborationTestIds } from "../testIds";

/**
 * Confirmation for deleting an Issue. Deletion is destructive and cascades to
 * sub-issues, and it stops any AI run still executing the Issue, so the copy
 * names both consequences before the action is allowed.
 */
export function IssueDeleteDialog({
  busy,
  error,
  hasChildren,
  onCancel,
  onConfirm,
  title,
  translate,
}: {
  busy: boolean;
  error: string | null;
  hasChildren: boolean;
  onCancel(): void;
  onConfirm(): void;
  title: string;
  translate: CollaborationTranslate;
}) {
  const dialogTitle = translate("todo.delete_issue_title", "删除任务？");

  return (
    <div
      aria-label={dialogTitle}
      aria-modal="true"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-6"
      data-testid={collaborationTestIds.issueDeleteDialog}
      role="dialog"
      onMouseDown={(event) => {
        if (busy) return;
        if (event.currentTarget === event.target) onCancel();
      }}
    >
      <div className="w-full max-w-[420px] overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        <header className="flex h-12 shrink-0 items-center border-b border-border px-5">
          <h2 className="text-sm font-semibold text-text-primary">
            {dialogTitle}
          </h2>
        </header>
        <div className="px-5 pb-5 pt-4">
          <p className="text-sm leading-5 text-text-secondary">
            {translate(
              hasChildren
                ? "todo.delete_issue_children_description"
                : "todo.delete_issue_description",
              hasChildren
                ? "“{{title}}”及其子任务将从看板中隐藏。"
                : "“{{title}}”将从看板中隐藏。",
              { title },
            )}
          </p>
          <p className="mt-2 text-xs leading-5 text-text-muted">
            {translate(
              "todo.delete_issue_execution_hint",
              "该任务正在执行的 AI 运行会被停止。",
            )}
          </p>
          <p className="mt-1 text-xs leading-5 text-text-muted">
            {translate(
              "todo.delete_issue_recycle_hint",
              "删除的数据会保留，不会立即永久删除。",
            )}
          </p>
          {error ? (
            <p
              className="mt-3 text-xs leading-5 text-red-600"
              data-testid={collaborationTestIds.issueDeleteError}
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <button
              className="h-9 rounded-lg border border-border px-4 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
              data-testid={collaborationTestIds.issueDeleteCancel}
              disabled={busy}
              onClick={onCancel}
              type="button"
            >
              {translate("common.cancel", "取消")}
            </button>
            <button
              className="h-9 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              data-testid={collaborationTestIds.issueDeleteConfirm}
              disabled={busy}
              onClick={onConfirm}
              type="button"
            >
              {busy
                ? translate("todo.deleting", "删除中…")
                : translate("todo.confirm_delete", "确认删除")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
