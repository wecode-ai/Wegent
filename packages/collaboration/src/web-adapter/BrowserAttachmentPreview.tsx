// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Download, Loader2, X } from 'lucide-react'
import { useCallback, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { CollaborationTranslate } from '../i18n'
import { useAttachmentPreview } from '../files/useAttachmentPreview'
import { IssueActivityMarkdown } from '../issue-detail/IssueActivityMarkdown'
import { useIssueResources } from '../issue-detail/issueResourcesContext'
import { formatIssueAttachmentSize } from '../issue-detail/issueAttachmentSize'
import { Button } from '../markdown/Button'
import { useEscapeKey } from '../markdown/useEscapeKey'
import { useCollaborationPortalTheme } from '../theme'

interface BrowserAttachmentPreviewProps {
  attachmentId: string
  filename: string
  read(attachmentId: string): Promise<Blob>
  translate: CollaborationTranslate
  onClose(): void
  onOpenAttachment?(id: string, filename: string): void
}

export function BrowserAttachmentPreview({
  attachmentId,
  filename,
  read,
  translate,
  onClose,
  onOpenAttachment,
}: BrowserAttachmentPreviewProps) {
  const theme = useCollaborationPortalTheme()
  const resources = useIssueResources()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const load = useCallback(
    async () =>
      resources
        ? (await resources.read(`wegent://attachments/${attachmentId}`)).blob
        : read(attachmentId),
    [resources, read, attachmentId]
  )
  const { preview, failed, loading, markLoaded, markFailed, retry } = useAttachmentPreview(
    load,
    filename
  )
  useEscapeKey(onClose, true, dialogRef)

  useLayoutEffect(() => {
    const trigger = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => {
      dialog.close()
      if (trigger?.isConnected) trigger.focus()
    }
  }, [])

  return createPortal(
    <dialog
      {...theme}
      ref={dialogRef}
      data-testid="browser-attachment-preview-dialog"
      aria-label={filename}
      className={`${theme.className} fixed inset-0 m-auto h-[calc(100dvh-2rem)] w-[calc(100dvw-2rem)] max-w-6xl rounded-2xl border border-border bg-background p-0 text-text-primary shadow-2xl backdrop:bg-black/70`}
      onCancel={event => {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border p-3">
          <span className="min-w-0 flex-1 truncate">{filename}</span>
          {preview ? (
            <Button asChild variant="ghost" size="icon" className="h-11 w-11">
              <a
                data-testid="browser-attachment-preview-download"
                href={preview.url}
                download={filename}
                aria-label={translate('todo.download_name', undefined, {
                  name: filename,
                })}
              >
                <Download aria-hidden="true" />
              </a>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            data-testid="browser-attachment-preview-close"
            aria-label={translate('todo.close_preview')}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </header>
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
          {failed ? (
            <div>
              <p role="alert">{translate('todo.file_preview_failed')}</p>
              <button
                type="button"
                data-testid="browser-attachment-preview-retry"
                className="ml-2 min-h-11 min-w-11 underline md:min-h-0 md:min-w-0"
                onClick={retry}
              >
                {translate('attachment.retry')}
              </button>
            </div>
          ) : (
            <>
              {loading ? (
                <Loader2
                  role="status"
                  aria-label={translate('todo.file_downloading')}
                  className="absolute h-7 w-7 animate-spin"
                />
              ) : null}
              {preview?.kind === 'image' ? (
                <img
                  data-testid="browser-attachment-preview-image"
                  src={preview.url}
                  alt={filename}
                  className="max-h-full max-w-full object-contain"
                  onLoad={markLoaded}
                  onError={markFailed}
                />
              ) : preview?.kind === 'markdown' ? (
                <article
                  data-testid="browser-attachment-preview-markdown"
                  className="h-full w-full overflow-auto p-3"
                >
                  <IssueActivityMarkdown
                    content={preview.text ?? ''}
                    variant="document"
                    translate={translate}
                    onOpenAttachment={onOpenAttachment}
                  />
                </article>
              ) : preview?.kind === 'text' ? (
                <pre
                  data-testid="browser-attachment-preview-text"
                  className="h-full w-full whitespace-pre-wrap break-words text-sm"
                >
                  {preview.text}
                </pre>
              ) : preview ? (
                <p data-testid="browser-attachment-preview-binary">
                  {filename} · {formatIssueAttachmentSize(preview.size)}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </dialog>,
    document.body
  )
}
