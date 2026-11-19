import { DialogSurface } from '../controls/DialogSurface'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ArrowLeft, X } from 'lucide-react'
import { useRef, type ReactNode } from 'react'

export function TemplateDialog({
  title,
  description,
  closeLabel,
  children,
  footer,
  onClose,
  busy = false,
  embedded = false,
  kind = 'dialog',
}: {
  title: string
  description?: string
  closeLabel: string
  children: ReactNode
  footer?: ReactNode
  onClose(): void
  busy?: boolean
  embedded?: boolean
  kind?: 'dialog' | 'alertdialog'
}) {
  const ref = useRef<HTMLDivElement>(null)

  const content = (
    <>
      <header>
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <ControlButton
          variant="unstyled"
          type="button"
          className="collaboration-template-icon-button"
          aria-label={closeLabel}
          data-testid="collaboration-template-close"
          disabled={busy}
          onClick={onClose}
        >
          {embedded ? <ArrowLeft aria-hidden="true" /> : <X aria-hidden="true" />}
        </ControlButton>
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
    <DialogSurface
      inline={false}
      kind={kind}
      onClose={() => {
        if (!busy) onClose()
      }}
      render={
        <div
          ref={ref}
          className="collaboration-template-dialog"
          aria-label={title}
          data-testid="collaboration-template-dialog"
        />
      }
    >
      {content}
    </DialogSurface>
  )
}
