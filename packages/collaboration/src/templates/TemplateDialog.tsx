// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useRef, type ReactNode } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { useEscapeKey } from '../markdown/useEscapeKey'

export function TemplateDialog({
  title,
  description,
  closeLabel,
  children,
  footer,
  onClose,
  busy = false,
  embedded = false,
}: {
  title: string
  description?: string
  closeLabel: string
  children: ReactNode
  footer?: ReactNode
  onClose(): void
  busy?: boolean
  embedded?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEscapeKey(
    () => {
      if (!busy) onClose()
    },
    true,
    ref
  )
  const attachDialog = useCallback((dialog: HTMLDialogElement | null) => {
    ref.current = dialog
    if (!dialog) return
    const previous = document.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      ref.current = null
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  const content = (
    <>
      <header>
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button
          type="button"
          className="collaboration-template-icon-button"
          aria-label={closeLabel}
          data-testid="collaboration-template-close"
          disabled={busy}
          onClick={onClose}
        >
          {embedded ? <ArrowLeft aria-hidden="true" /> : <X aria-hidden="true" />}
        </button>
      </header>
      <div className="collaboration-template-dialog-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </>
  )
  return embedded ? (
    <section
      aria-label={title}
      className="collaboration-template-detail"
      data-testid="template-detail-inline"
    >
      {content}
    </section>
  ) : (
    <dialog
      ref={attachDialog}
      className="collaboration-template-dialog"
      aria-label={title}
      data-testid="collaboration-template-dialog"
      onCancel={event => {
        event.preventDefault()
        event.stopPropagation()
        if (!busy) onClose()
      }}
    >
      {content}
    </dialog>
  )
}
