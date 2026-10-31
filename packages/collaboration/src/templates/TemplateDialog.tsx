// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function TemplateDialog({
  title,
  description,
  closeLabel,
  children,
  footer,
  onClose,
  busy = false,
}: {
  title: string
  description?: string
  closeLabel: string
  children: ReactNode
  footer?: ReactNode
  onClose(): void
  busy?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    const dialog = ref.current!
    dialog.showModal()
    return () => {
      dialog.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className="collaboration-template-dialog"
      aria-label={title}
      data-testid="collaboration-template-dialog"
      onCancel={event => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
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
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="collaboration-template-dialog-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </dialog>
  )
}
