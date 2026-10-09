// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTranslate } from "../i18n";
import { collaborationTestIds } from "../testIds";

export function IssueArchiveDialog({
  busy,
  count = 1,
  error,
  hasChildren,
  onCancel,
  onConfirm,
  title,
  translate,
}: {
  busy: boolean;
  count?: number;
  error: string | null;
  hasChildren: boolean;
  onCancel(): void;
  onConfirm(): void;
  title?: string;
  translate: CollaborationTranslate;
}) {
  const dialogTitle = translate(
    count > 1
      ? "todo.archive_completed_tasks_title"
      : "todo.archive_issue_title",
    count > 1 ? "归档已完成任务？" : "归档任务？",
  );

  return (
    <div
      aria-label={dialogTitle}
      aria-modal="true"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-6"
      data-testid={collaborationTestIds.issueArchiveDialog}
      role="dialog"
      onMouseDown={(event) => {
        if (!busy && event.currentTarget === event.target) onCancel();
      }}
    >
      <div className="w-full max-w-[420px] overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        <header className="flex h-12 items-center border-b border-border px-5">
          <h2 className="text-sm font-semibold text-text-primary">
            {dialogTitle}
          </h2>
        </header>
        <div className="px-5 pb-5 pt-4">
          <p className="text-sm leading-5 text-text-secondary">
            {count > 1
              ? translate(
                  "todo.archive_completed_tasks_description",
                  "将从看板中归档 {{count}} 个已完成任务。",
                  { count },
                )
              : translate(
                  hasChildren
                    ? "todo.archive_issue_children_description"
                    : "todo.archive_issue_description",
                  hasChildren
                    ? "“{{title}}”及同批已完成子任务将从看板中归档。"
                    : "“{{title}}”将从看板中归档。",
                  { title: title ?? "" },
                )}
          </p>
          <p className="mt-2 text-xs leading-5 text-text-muted">
            {translate(
              "todo.archive_issue_restore_hint",
              "归档后可从当前项目的归档箱恢复。",
            )}
          </p>
          {error ? (
            <p
              className="mt-3 text-xs leading-5 text-red-600"
              data-testid={collaborationTestIds.issueArchiveError}
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <button
              className="h-9 rounded-lg border border-border px-4 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
              data-testid={collaborationTestIds.issueArchiveCancel}
              disabled={busy}
              onClick={onCancel}
              type="button"
            >
              {translate("common.cancel", "取消")}
            </button>
            <button
              className="h-9 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
              data-testid={collaborationTestIds.issueArchiveConfirm}
              disabled={busy}
              onClick={onConfirm}
              type="button"
            >
              {busy
                ? translate("todo.archiving", "归档中…")
                : translate("todo.confirm_archive", "确认归档")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
