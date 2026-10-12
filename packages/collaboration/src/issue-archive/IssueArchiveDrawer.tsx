// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTranslate } from "../i18n";
import { canEditCollaborationIssue } from "../permissions";
import { collaborationTestIds } from "../testIds";
import type { CollaborationIssue } from "../types";

export function IssueArchiveDrawer({
  busyId,
  error,
  items,
  loading,
  nextCursor,
  onClose,
  onLoadMore,
  onRestore,
  translate,
}: {
  busyId: string | null;
  error: string | null;
  items: CollaborationIssue[];
  loading: boolean;
  nextCursor: string | null;
  onClose(): void;
  onLoadMore(): void;
  onRestore(issue: CollaborationIssue): void;
  translate: CollaborationTranslate;
}) {
  return (
    <div
      className="fixed inset-0 z-modal flex justify-end bg-black/25"
      data-testid={collaborationTestIds.issueArchiveDrawer}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <aside
        aria-label={translate("todo.archive_box", "已归档")}
        className="flex h-full w-full max-w-md flex-col border-l border-border bg-background shadow-xl"
      >
        <header className="flex h-12 items-center justify-between border-b border-border px-4">
          <h2 className="text-sm font-semibold text-text-primary">
            {translate("todo.archive_box", "已归档")}
          </h2>
          <button
            type="button"
            className="h-8 rounded-lg px-3 text-xs text-text-secondary hover:bg-muted"
            data-testid={collaborationTestIds.issueArchiveDrawerClose}
            onClick={onClose}
          >
            {translate("common.close", "关闭")}
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <p className="mb-3 text-xs text-red-600" role="alert">
              {error}
            </p>
          ) : null}
          {!loading && items.length === 0 ? (
            <p className="py-12 text-center text-sm text-text-muted">
              {translate("todo.archive_box_empty", "暂无已归档任务")}
            </p>
          ) : null}
          <div className="space-y-2">
            {items.map((issue) => (
              <article
                className="rounded-xl border border-border p-3"
                data-testid={`collaboration-archived-issue-${issue.id}`}
                key={issue.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium text-text-primary">
                      {issue.title}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {issue.archived_at
                        ? new Date(issue.archived_at).toLocaleString()
                        : ""}
                    </p>
                  </div>
                  {canEditCollaborationIssue(issue) ? (
                    <button
                      type="button"
                      className="h-8 shrink-0 rounded-lg border border-border px-3 text-xs font-medium text-text-primary hover:bg-muted disabled:opacity-50"
                      data-testid={`collaboration-archived-issue-restore-${issue.id}`}
                      disabled={busyId !== null}
                      onClick={() => onRestore(issue)}
                    >
                      {busyId === issue.id
                        ? translate("todo.restoring", "恢复中…")
                        : translate("todo.restore_issue", "恢复")}
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
          {loading ? (
            <p className="py-6 text-center text-xs text-text-muted">
              {translate("common.loading", "正在加载…")}
            </p>
          ) : null}
          {!loading && nextCursor ? (
            <button
              type="button"
              className="mt-3 h-9 w-full rounded-lg border border-border text-xs font-medium text-text-secondary hover:bg-muted"
              data-testid={collaborationTestIds.issueArchiveLoadMore}
              onClick={onLoadMore}
            >
              {translate("common.load_more", "加载更多")}
            </button>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
