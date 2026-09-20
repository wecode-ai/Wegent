// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export interface IssueDetailSurfaceProps {
  testId: string;
  accessibleTitle: string;
  className?: string;
  header: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  onDrop?: (event: DragEvent<HTMLElement>) => void;
}

export function IssueDetailSurface({
  testId,
  accessibleTitle,
  className,
  header,
  children,
  aside,
  footer,
  onClose,
  onKeyDown,
  onDrop,
}: IssueDetailSurfaceProps) {
  return (
    <div
      className={classes("shared-issue-detail-backdrop", className)}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose?.();
      }}
    >
      <section
        className="shared-issue-detail-surface"
        data-testid={testId}
        onKeyDown={onKeyDown}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        <span className="shared-issue-detail-sr-only">{accessibleTitle}</span>
        <header className="shared-issue-detail-header">{header}</header>
        <div className="shared-issue-detail-layout">
          <main className="shared-issue-detail-main">{children}</main>
          {aside ? (
            <aside className="shared-issue-detail-aside">{aside}</aside>
          ) : null}
        </div>
        {footer ? (
          <footer className="shared-issue-detail-footer">{footer}</footer>
        ) : null}
      </section>
    </div>
  );
}

export function IssueDetailFields({ children }: { children: ReactNode }) {
  return <div className="shared-issue-detail-fields">{children}</div>;
}

export function IssueDetailActivity({
  title,
  count,
  children,
  className,
}: {
  title: ReactNode;
  count?: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={classes("shared-issue-detail-activity", className)}>
      <header className="shared-issue-detail-section-header">
        <h3>{title}</h3>
        {typeof count === "number" ? <span>{count}</span> : null}
      </header>
      {children}
    </section>
  );
}

export interface IssueDetailAttachment {
  id: string;
  displayName: string;
  sizeBytes: number;
}

export interface IssueDetailAttachmentIcons {
  section?: ReactNode;
  upload?: ReactNode;
  file?: ReactNode;
  download?: ReactNode;
  loading?: ReactNode;
  remove?: ReactNode;
}

export interface IssueDetailAttachmentsProps {
  attachments: IssueDetailAttachment[];
  busy: boolean;
  error: string | null;
  editable: boolean;
  compact?: boolean;
  downloadingId?: string | null;
  labels: {
    title: string;
    upload: string;
    uploading: string;
    empty: string;
    dropzone: string;
    downloading: string;
    open?: (name: string) => string;
    expand: (count: number) => string;
    collapse: string;
    download: (name: string) => string;
    remove: (name: string) => string;
  };
  testIdPrefix: string;
  inputTestId?: string;
  openTestId?: (id: string) => string;
  downloadTestId?: (id: string) => string;
  removeTestId?: (id: string) => string;
  icons?: IssueDetailAttachmentIcons;
  onAdd: (files: FileList | null) => Promise<void>;
  onOpen?: (attachment: IssueDetailAttachment) => Promise<void>;
  onDownload?: (attachment: IssueDetailAttachment) => Promise<void>;
  onRemove: (attachment: IssueDetailAttachment) => Promise<void>;
}

export function formatIssueAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function IssueDetailAttachments({
  attachments,
  busy,
  error,
  editable,
  compact = false,
  downloadingId,
  labels,
  testIdPrefix,
  inputTestId = `${testIdPrefix}-input`,
  openTestId = (id) => `${testIdPrefix}-open-${id}`,
  downloadTestId = (id) => `${testIdPrefix}-download-${id}`,
  removeTestId = (id) => `${testIdPrefix}-delete-${id}`,
  icons,
  onAdd,
  onOpen,
  onDownload,
  onRemove,
}: IssueDetailAttachmentsProps) {
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const visibleRows =
    compact && !expanded ? attachments.slice(0, 2) : attachments;
  const hasOverflow = compact && attachments.length > 2;

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    void onAdd(event.target.files);
    event.target.value = "";
  };
  const dropHandlers = {
    onDragEnter(event: DragEvent<HTMLElement>) {
      event.preventDefault();
      setDragging(true);
    },
    onDragOver(event: DragEvent<HTMLElement>) {
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (event.currentTarget.contains(event.relatedTarget as Node | null))
        return;
      setDragging(false);
    },
    onDrop(event: DragEvent<HTMLElement>) {
      event.preventDefault();
      setDragging(false);
      void onAdd(event.dataTransfer.files);
    },
  };

  return (
    <section
      className={classes(
        compact
          ? "task-detail-rail-section"
          : "shared-issue-detail-attachments",
        dragging && "is-dragging",
      )}
    >
      <div
        className={
          compact
            ? "task-detail-section-label"
            : "shared-issue-detail-section-header"
        }
      >
        <h3>
          {icons?.section}
          {labels.title}
        </h3>
        <span className={compact ? "count" : undefined}>
          {attachments.length}
        </span>
        {editable && compact ? (
          <label className="add">
            {busy ? labels.uploading : labels.upload}
            <input
              data-testid={inputTestId}
              type="file"
              multiple
              disabled={busy}
              onChange={upload}
              className="shared-issue-detail-file-input"
            />
          </label>
        ) : null}
      </div>
      {error ? (
        <p
          className={
            compact ? "task-detail-rail-error" : "shared-issue-detail-error"
          }
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div
        className={classes(
          compact
            ? "task-detail-attachment-body"
            : "shared-issue-detail-attachment-body",
          expanded && "expanded-scroll",
        )}
        {...dropHandlers}
      >
        {attachments.length === 0 ? (
          <p
            className={
              compact
                ? "task-detail-rail-empty"
                : "shared-issue-detail-attachment-empty"
            }
          >
            {labels.empty}
          </p>
        ) : (
          <div
            className={
              compact
                ? "task-detail-rail-list"
                : "shared-issue-detail-attachment-list"
            }
          >
            {visibleRows.map((attachment) => (
              <div
                key={attachment.id}
                className={
                  compact
                    ? "task-detail-rail-file group"
                    : "shared-issue-detail-attachment-row"
                }
              >
                <button
                  type="button"
                  data-testid={
                    onDownload
                      ? openTestId(attachment.id)
                      : downloadTestId(attachment.id)
                  }
                  disabled={!onOpen || downloadingId === attachment.id}
                  onClick={() => {
                    if (onOpen) void onOpen(attachment);
                  }}
                  className={
                    compact
                      ? "task-detail-rail-download"
                      : "shared-issue-detail-attachment-open"
                  }
                  title={attachment.displayName}
                  aria-label={
                    onDownload
                      ? (labels.open?.(attachment.displayName) ??
                        labels.download(attachment.displayName))
                      : labels.download(attachment.displayName)
                  }
                >
                  <span
                    className={
                      compact
                        ? "task-detail-rail-icon"
                        : "shared-issue-detail-attachment-icon"
                    }
                  >
                    {downloadingId === attachment.id
                      ? (icons?.loading ?? icons?.file)
                      : (icons?.file ?? icons?.download)}
                  </span>
                  <span
                    className={
                      compact
                        ? "task-detail-rail-name"
                        : "shared-issue-detail-attachment-name"
                    }
                  >
                    {attachment.displayName}
                  </span>
                  <span
                    className={
                      compact
                        ? "task-detail-rail-meta"
                        : "shared-issue-detail-attachment-meta"
                    }
                  >
                    {downloadingId === attachment.id
                      ? labels.downloading
                      : formatIssueAttachmentSize(attachment.sizeBytes)}
                  </span>
                </button>
                {onDownload ? (
                  <button
                    type="button"
                    data-testid={downloadTestId(attachment.id)}
                    disabled={downloadingId === attachment.id}
                    className="shared-issue-detail-attachment-delete"
                    aria-label={labels.download(attachment.displayName)}
                    onClick={() => void onDownload(attachment)}
                  >
                    {icons?.download ?? "↓"}
                  </button>
                ) : null}
                {editable ? (
                  <button
                    type="button"
                    data-testid={removeTestId(attachment.id)}
                    disabled={busy}
                    onClick={() => void onRemove(attachment)}
                    className={
                      compact
                        ? "task-detail-rail-delete"
                        : "shared-issue-detail-attachment-delete"
                    }
                    aria-label={labels.remove(attachment.displayName)}
                  >
                    {icons?.remove ?? "×"}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {editable ? (
          <label
            className={
              compact
                ? "task-detail-rail-dropzone"
                : "shared-issue-detail-attachment-dropzone"
            }
          >
            {icons?.upload}
            {busy ? labels.uploading : labels.dropzone}
            <input
              data-testid={compact ? undefined : inputTestId}
              type="file"
              multiple
              disabled={busy}
              onChange={upload}
              className="shared-issue-detail-file-input"
            />
          </label>
        ) : null}
      </div>
      {hasOverflow ? (
        <button
          type="button"
          className="task-detail-rail-more"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? labels.collapse : labels.expand(attachments.length)}
        </button>
      ) : null}
    </section>
  );
}
