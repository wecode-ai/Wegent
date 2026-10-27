// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Download, Loader2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CollaborationTranslate } from '../i18n'
import { collaborationFilePreviewKind } from '../files/preview'
import { formatIssueAttachmentSize } from '../issue-detail/IssueDetailCore'
import { Button } from '../markdown/Button'
import { useEscapeKey } from '../markdown/useEscapeKey'
import { useCollaborationPortalTheme } from '../theme'

interface BrowserAttachmentPreviewProps {
  attachmentId: string
  filename: string
  read(attachmentId: string): Promise<Blob>
  translate: CollaborationTranslate
  onClose(): void
}

export function BrowserAttachmentPreview({
  attachmentId,
  filename,
  read,
  translate,
  onClose,
}: BrowserAttachmentPreviewProps) {
  const theme = useCollaborationPortalTheme()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [preview, setPreview] = useState<{
    url: string
    size: number
    kind: 'image' | 'text' | 'binary'
    text?: string
  } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
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

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    setPreview(null)
    setLoaded(false)
    setFailed(false)
    async function load() {
      try {
        const blob = await read(attachmentId)
        if (!active) return
        const kind = blob.type.startsWith('image/')
          ? 'image'
          : collaborationFilePreviewKind(filename, blob.type) === 'text'
            ? 'text'
            : 'binary'
        const text = kind === 'text' ? await blob.text() : undefined
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        setPreview({ url: objectUrl, size: blob.size, kind, text })
        setLoaded(kind !== 'image')
      } catch {
        if (active) setFailed(true)
      }
    }
    void load()
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachmentId, filename, read])

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
                aria-label={translate('todo.download_name', undefined, { name: filename })}
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
            <p role="alert">{translate('todo.file_preview_failed')}</p>
          ) : (
            <>
              {!loaded ? (
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
                  onLoad={() => setLoaded(true)}
                  onError={() => setFailed(true)}
                />
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
