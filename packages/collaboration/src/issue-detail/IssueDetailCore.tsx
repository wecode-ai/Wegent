import { TextField as ControlInput } from '../controls/TextField'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

import { createAsyncResource } from '@wegent/chat-core/async-resource'

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export interface IssueDetailSurfaceProps {
  testId: string
  accessibleTitle: string
  className?: string
  header: ReactNode
  children: ReactNode
  aside?: ReactNode
  footer?: ReactNode
  onClose?: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
  onDrop?: (event: DragEvent<HTMLElement>) => void
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
      className={classes('shared-issue-detail-backdrop', className)}
      onMouseDown={event => {
        if (event.currentTarget === event.target) onClose?.()
      }}
    >
      <section
        className="shared-issue-detail-surface"
        data-testid={testId}
        onKeyDown={onKeyDown}
        onDragOver={event => event.preventDefault()}
        onDrop={onDrop}
      >
        <span className="shared-issue-detail-sr-only">{accessibleTitle}</span>
        <header className="shared-issue-detail-header">{header}</header>
        <div className="shared-issue-detail-layout">
          <main className="shared-issue-detail-main">{children}</main>
          {aside ? <aside className="shared-issue-detail-aside">{aside}</aside> : null}
        </div>
        {footer ? <footer className="shared-issue-detail-footer">{footer}</footer> : null}
      </section>
    </div>
  )
}

export function IssueDetailFields({ children }: { children: ReactNode }) {
  return <div className="shared-issue-detail-fields">{children}</div>
}

export function IssueDetailActivity({
  title,
  count,
  children,
  className,
}: {
  title: ReactNode
  count?: number
  children: ReactNode
  className?: string
}) {
  return (
    <section className={classes('shared-issue-detail-activity', className)}>
      <header className="shared-issue-detail-section-header">
        <h3>{title}</h3>
        {typeof count === 'number' ? <span>{count}</span> : null}
      </header>
      {children}
    </section>
  )
}

export interface IssueDetailAttachment {
  removable?: boolean
  id: string
  displayName: string
  contentType?: string | null
  sizeBytes: number
}

export interface IssueDetailAttachmentIcons {
  section?: ReactNode
  upload?: ReactNode
  file?: ReactNode
  download?: ReactNode
  loading?: ReactNode
  remove?: ReactNode
}

export interface IssueDetailAttachmentsProps {
  attachments: IssueDetailAttachment[]
  busy: boolean
  error: string | null
  editable: boolean
  compact?: boolean
  totalCount?: number
  downloadingId?: string | null
  labels: {
    title: string
    upload: string
    uploading: string
    empty: string
    dropzone: string
    downloading: string
    open?: (name: string) => string
    expand: (count: number) => string
    collapse: string
    download: (name: string) => string
    remove: (name: string) => string
  }
  testIdPrefix: string
  inputTestId?: string
  openTestId?: (id: string) => string
  downloadTestId?: (id: string) => string
  removeTestId?: (id: string) => string
  icons?: IssueDetailAttachmentIcons
  onAdd: (files: FileList | null) => Promise<void>
  loadPreview?: (attachmentId: string) => Promise<Blob>
  onOpen?: (attachment: IssueDetailAttachment) => Promise<void>
  onDownload?: (attachment: IssueDetailAttachment) => Promise<void>
  onRemove: (attachment: IssueDetailAttachment) => Promise<void>
}

function isImageAttachment(attachment: IssueDetailAttachment): boolean {
  if (attachment.contentType?.startsWith('image/')) return true
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i.test(attachment.displayName)
}

function IssueDetailAttachmentPreview({
  attachment,
  fallback,
  loadPreview,
}: {
  attachment: IssueDetailAttachment
  fallback: ReactNode
  loadPreview?: (attachmentId: string) => Promise<Blob>
}) {
  return loadPreview && isImageAttachment(attachment) ? (
    <IssueDetailImagePreview
      key={attachment.id}
      attachmentId={attachment.id}
      fallback={fallback}
      loadPreview={loadPreview}
    />
  ) : (
    <span className="issue-detail-attachment-fallback">{fallback}</span>
  )
}

function IssueDetailImagePreview({
  attachmentId,
  fallback,
  loadPreview,
}: {
  attachmentId: string
  fallback: ReactNode
  loadPreview: (attachmentId: string) => Promise<Blob>
}) {
  // Loader closures may change on parent renders without changing the attachment identity.
  const [resource] = useState(() =>
    createAsyncResource(
      attachmentId,
      async signal => {
        const blob = await loadPreview(attachmentId)
        signal.throwIfAborted()
        return URL.createObjectURL(blob)
      },
      {
        release: url => URL.revokeObjectURL(url),
      }
    )
  )
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  )
  const [failed, setFailed] = useState(false)
  const previewUrl = failed ? null : snapshot.data

  return previewUrl ? (
    <img
      data-testid={'issue-detail-attachment-thumbnail-' + attachmentId}
      className="issue-detail-attachment-thumbnail"
      src={previewUrl}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="issue-detail-attachment-fallback">{fallback}</span>
  )
}

export function IssueDetailAttachments({
  attachments,
  busy,
  error,
  editable,
  compact = false,
  totalCount,
  downloadingId,
  labels,
  testIdPrefix,
  inputTestId = `${testIdPrefix}-input`,
  openTestId = id => `${testIdPrefix}-open-${id}`,
  downloadTestId = id => `${testIdPrefix}-download-${id}`,
  removeTestId = id => `${testIdPrefix}-delete-${id}`,
  icons,
  onAdd,
  loadPreview,
  onOpen,
  onDownload,
  onRemove,
}: IssueDetailAttachmentsProps) {
  const [dragging, setDragging] = useState(false)

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    void onAdd(event.target.files)
    event.target.value = ''
  }
  const dropHandlers = {
    onDragEnter(event: DragEvent<HTMLElement>) {
      event.preventDefault()
      setDragging(true)
    },
    onDragOver(event: DragEvent<HTMLElement>) {
      event.preventDefault()
      setDragging(true)
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      setDragging(false)
    },
    onDrop(event: DragEvent<HTMLElement>) {
      event.preventDefault()
      setDragging(false)
      void onAdd(event.dataTransfer.files)
    },
  }

  return (
    <section
      className={classes(
        compact ? 'task-detail-rail-section' : 'shared-issue-detail-attachments',
        dragging && 'is-dragging'
      )}
    >
      <div className={compact ? 'task-detail-section-label' : 'shared-issue-detail-section-header'}>
        <h3>
          {icons?.section}
          {labels.title}
        </h3>
        {(totalCount ?? attachments.length) > 0 ? (
          <span className={compact ? 'count' : undefined}>{totalCount ?? attachments.length}</span>
        ) : null}
        {editable && compact ? (
          <label className="add">
            {busy ? labels.uploading : labels.upload}
            <ControlInput
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
          className={compact ? 'task-detail-rail-error' : 'shared-issue-detail-error'}
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div
        className={classes(
          compact ? 'task-detail-attachment-body' : 'shared-issue-detail-attachment-body'
        )}
        {...dropHandlers}
      >
        {attachments.length === 0 ? (
          compact ? null : (
            <p
              className={
                compact ? 'task-detail-rail-empty' : 'shared-issue-detail-attachment-empty'
              }
            >
              {labels.empty}
            </p>
          )
        ) : (
          <div
            className={compact ? 'task-detail-rail-list' : 'shared-issue-detail-attachment-list'}
          >
            {attachments.map(attachment => (
              <div
                key={attachment.id}
                className={
                  compact ? 'task-detail-rail-file group' : 'shared-issue-detail-attachment-row'
                }
              >
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={onOpen ? openTestId(attachment.id) : downloadTestId(attachment.id)}
                  disabled={!onOpen || downloadingId === attachment.id}
                  onClick={() => {
                    if (onOpen) void onOpen(attachment)
                  }}
                  className={
                    compact ? 'task-detail-rail-download' : 'shared-issue-detail-attachment-open'
                  }
                  title={attachment.displayName}
                  aria-label={
                    onOpen
                      ? (labels.open?.(attachment.displayName) ??
                        labels.download(attachment.displayName))
                      : labels.download(attachment.displayName)
                  }
                >
                  <span
                    className={
                      compact ? 'task-detail-rail-preview' : 'shared-issue-detail-attachment-icon'
                    }
                  >
                    <IssueDetailAttachmentPreview
                      attachment={attachment}
                      loadPreview={loadPreview}
                      fallback={
                        downloadingId === attachment.id
                          ? (icons?.loading ?? icons?.file)
                          : (icons?.file ?? icons?.download)
                      }
                    />
                  </span>
                  <span className="issue-detail-attachment-caption">
                    <span
                      className={
                        compact ? 'task-detail-rail-name' : 'shared-issue-detail-attachment-name'
                      }
                    >
                      {attachment.displayName}
                    </span>
                    {downloadingId === attachment.id ? (
                      <span
                        className={
                          compact ? 'task-detail-rail-meta' : 'shared-issue-detail-attachment-meta'
                        }
                      >
                        {labels.downloading}
                      </span>
                    ) : null}
                  </span>
                </ControlButton>
                {onDownload ? (
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid={downloadTestId(attachment.id)}
                    disabled={downloadingId === attachment.id}
                    className="shared-issue-detail-attachment-delete"
                    aria-label={labels.download(attachment.displayName)}
                    onClick={() => void onDownload(attachment)}
                  >
                    {icons?.download ?? '↓'}
                  </ControlButton>
                ) : null}
                {editable && attachment.removable !== false ? (
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid={removeTestId(attachment.id)}
                    disabled={busy}
                    onClick={() => void onRemove(attachment)}
                    className={
                      compact ? 'task-detail-rail-delete' : 'shared-issue-detail-attachment-delete'
                    }
                    aria-label={labels.remove(attachment.displayName)}
                  >
                    {icons?.remove ?? '×'}
                  </ControlButton>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {editable && (!compact || attachments.length > 0) ? (
          <label
            className={
              compact ? 'task-detail-rail-dropzone' : 'shared-issue-detail-attachment-dropzone'
            }
          >
            {icons?.upload}
            {busy ? labels.uploading : labels.dropzone}
            <ControlInput
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
    </section>
  )
}
