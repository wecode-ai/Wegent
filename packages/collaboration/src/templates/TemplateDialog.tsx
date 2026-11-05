// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type ReactNode } from 'react'
import { ArrowLeft, X } from 'lucide-react'

export type TemplateDialogSize = 'compact' | 'standard' | 'wide'

export function TemplateDialog({
  title,
  description,
  closeLabel,
  children,
  footer,
  onClose,
  busy = false,
  size = 'wide',
  back,
}: {
  title: string
  description?: string
  closeLabel: string
  children: ReactNode
  footer?: ReactNode
  onClose(): void
  busy?: boolean
  size?: TemplateDialogSize
  back?: { label: string; onClick(): void }
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    const dialog = ref.current!
    dialog.showModal()
    return () => {
      dialog.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    // A sequential step can remove the focused control without remounting the dialog.
    if (ref.current?.open && !ref.current.contains(document.activeElement)) heading.current?.focus()
  }, [title])
  return (
    <dialog
      ref={ref}
      className="collaboration-template-dialog"
      data-size={size}
      aria-label={title}
      data-testid="collaboration-template-dialog"
      onCancel={event => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <header>
        {back && (
          <button
            type="button"
            className="collaboration-template-icon-button"
            aria-label={back.label}
            data-testid="template-dialog-back"
            disabled={busy}
            onClick={back.onClick}
          >
            <ArrowLeft aria-hidden="true" />
          </button>
        )}
        <div>
          <h2 ref={heading} tabIndex={-1}>
            {title}
          </h2>
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
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="collaboration-template-dialog-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </dialog>
  )
}
